import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashObject, parseCommit, parseTree, type ForgeStore, type Repository, type GitObject, type GitType } from './store.ts';

const zero = '0'.repeat(40);
type Packet = { kind: 'data'; data: Buffer; start: number; end: number } | { kind: 'flush' | 'delim' | 'end'; start: number; end: number };
function packet(data: string | Buffer): Buffer {
  const b = typeof data === 'string' ? Buffer.from(data) : data;
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
const flush = (): Buffer => Buffer.from('0000');
const delim = (): Buffer => Buffer.from('0001');
function parsePackets(b: Buffer): Packet[] {
  const out: Packet[] = []; let at = 0;
  while (at + 4 <= b.length) {
    const start = at, n = Number.parseInt(b.toString('ascii', at, at + 4), 16);
    if (!Number.isFinite(n)) break;
    at += 4;
    if (n === 0) { out.push({ kind: 'flush', start, end: at }); continue; }
    if (n === 1) { out.push({ kind: 'delim', start, end: at }); continue; }
    if (n === 2) { out.push({ kind: 'end', start, end: at }); continue; }
    if (n < 4 || start + n > b.length) { at = start; break; }
    const end = start + n;
    out.push({ kind: 'data', data: b.subarray(at, end), start, end }); at = end;
  }
  return out;
}
function packObjectHeader(type: GitType, size: number): Buffer {
  const code: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  let first = ((code[type] ?? 3) << 4) | (size & 15), rest = Math.floor(size / 16);
  const bytes = [first];
  if (rest) bytes[0] = first | 128;
  while (rest) { let x = rest & 127; rest = Math.floor(rest / 128); if (rest) x |= 128; bytes.push(x); }
  return Buffer.from(bytes);
}
function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects], header = Buffer.alloc(12);
  header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(list.length, 8);
  const chunks: Buffer[] = [header];
  for (const o of list) chunks.push(packObjectHeader(o.type, o.data.length), deflateSync(o.data));
  const bytes = Buffer.concat(chunks);
  return Buffer.concat([bytes, createHash('sha1').update(bytes).digest()]);
}
function readVarint(data: Buffer, cursor: { at: number }): number {
  let value = 0, shift = 0, byte = 0;
  do { byte = data[cursor.at++] ?? 0; value |= (byte & 127) << shift; shift += 7; } while (byte & 128);
  return value;
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const cur = { at: 0 }, baseSize = readVarint(delta, cur), targetSize = readVarint(delta, cur);
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = []; let written = 0;
  while (cur.at < delta.length) {
    const op = delta[cur.at++]!;
    if (op & 0x80) {
      let offset = 0, size = 0;
      if (op & 1) offset |= delta[cur.at++]!; if (op & 2) offset |= delta[cur.at++]! << 8;
      if (op & 4) offset |= delta[cur.at++]! << 16; if (op & 8) offset |= delta[cur.at++]! << 24;
      if (op & 16) size |= delta[cur.at++]!; if (op & 32) size |= delta[cur.at++]! << 8;
      if (op & 64) size |= delta[cur.at++]! << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size)); written += size;
    } else if (op) { out.push(delta.subarray(cur.at, cur.at + op)); cur.at += op; written += op; }
    else throw new Error('invalid delta opcode');
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}
function readPack(pack: Buffer, repo: Repository): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('invalid pack header');
  const count = pack.readUInt32BE(8), cursor = { at: 12 };
  const entries: Array<{ type: GitType | 'ofs' | 'ref'; data: Buffer; baseOffset?: number; baseOid?: string; offset: number }> = [];
  for (let i = 0; i < count; i++) {
    const offset = cursor.at; let c = pack[cursor.at++]!, typeNum = (c >> 4) & 7, size = c & 15, shift = 4;
    while (c & 128) { c = pack[cursor.at++]!; size |= (c & 127) << shift; shift += 7; }
    let type: GitType | 'ofs' | 'ref' = typeNum === 1 ? 'commit' : typeNum === 2 ? 'tree' : typeNum === 3 ? 'blob' : typeNum === 4 ? 'tag' : typeNum === 6 ? 'ofs' : 'ref';
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 'ofs') {
      let b = pack[cursor.at++]!, distance = b & 127;
      while (b & 128) { b = pack[cursor.at++]!; distance = ((distance + 1) << 7) | (b & 127); }
      baseOffset = offset - distance;
    } else if (type === 'ref') { baseOid = pack.toString('hex', cursor.at, cursor.at + 20); cursor.at += 20; }
    const inflated = inflateSync(pack.subarray(cursor.at), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    cursor.at += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    entries.push({ type, data: inflated.buffer, baseOffset, baseOid, offset });
  }
  const objects = new Map<string, GitObject>(), byOffset = new Map<number, { type: GitType; data: Buffer; oid: string }>();
  const pending = entries.slice();
  for (let pass = 0; pending.length && pass <= entries.length; pass++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const e = pending[i]!;
      let type: GitType, data: Buffer;
      if (e.type === 'ofs' || e.type === 'ref') {
        const base = e.type === 'ofs' ? byOffset.get(e.baseOffset!) : objects.get(e.baseOid!) ?? repo.objects.get(e.baseOid!);
        if (!base) continue;
        type = base.type; data = applyDelta(base.data, e.data);
      } else { type = e.type; data = e.data; }
      const oid = hashObject(type, data), obj = { type, data };
      objects.set(oid, obj); byOffset.set(e.offset, { ...obj, oid }); pending.splice(i, 1);
    }
  }
  if (pending.length) throw new Error('unresolved pack delta');
  return objects;
}
function reachable(repo: Repository, roots: string[], have: Set<string> = new Set(), depth?: number, shallow: Set<string> = new Set()): { objects: GitObject[]; boundaries: string[]; unshallow: string[] } {
  const all = new Set<string>(), commits = new Map<string, number>(), boundaries: string[] = [], unshallow: string[] = [];
  const queue = roots.map((oid) => ({ oid, level: 1 }));
  while (queue.length) {
    const { oid, level } = queue.shift()!;
    if (all.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    all.add(oid);
    if (obj.type === 'commit') {
      commits.set(oid, level);
      const c = parseCommit(obj.data);
      const limited = depth !== undefined && level >= depth;
      if (limited) { boundaries.push(oid); continue; }
      if (have.has(oid) && !shallow.has(oid)) {
        if (depth !== undefined) { for (const p of c.parents) queue.push({ oid: p, level: level + 1 }); }
        continue;
      }
      queue.push({ oid: c.tree, level });
      for (const p of c.parents) queue.push({ oid: p, level: level + 1 });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push({ oid: e.oid, level });
    } else if (obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1];
      if (target) queue.push({ oid: target, level });
    }
  }
  const set = new Set<string>();
  if (depth === undefined) {
    const walk = [...all], seen = new Set<string>();
    while (walk.length) {
      const oid = walk.pop()!; if (seen.has(oid) || have.has(oid)) continue; seen.add(oid);
      const obj = repo.objects.get(oid); if (!obj) continue;
      set.add(oid);
      if (obj.type === 'commit') { const c = parseCommit(obj.data); walk.push(c.tree, ...c.parents); }
      else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') walk.push(e.oid);
      else if (obj.type === 'tag') { const t = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1]; if (t) walk.push(t); }
    }
  } else {
    // At a shallow boundary, ship its tree and blobs but not its parents.
    for (const [oid, level] of commits) {
      if (level > depth) continue;
      const o = repo.objects.get(oid); if (!o) continue;
      set.add(oid);
      const c = parseCommit(o.data), walk = [c.tree], seen = new Set<string>();
      while (walk.length) {
        const item = walk.pop()!; if (seen.has(item) || have.has(item)) continue; seen.add(item);
        const obj = repo.objects.get(item); if (!obj) continue;
        set.add(item);
        if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') walk.push(e.oid);
      }
    }
  }
  const excluded = new Set<string>(), exclusionStack = [...have], exclusionSeen = new Set<string>();
  while (exclusionStack.length) {
    const oid = exclusionStack.pop()!;
    if (exclusionSeen.has(oid)) continue;
    exclusionSeen.add(oid);
    const obj = repo.objects.get(oid); if (!obj) continue;
    excluded.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      exclusionStack.push(c.tree);
      if (!shallow.has(oid)) exclusionStack.push(...c.parents);
    } else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') exclusionStack.push(e.oid);
    else if (obj.type === 'tag') { const t = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1]; if (t) exclusionStack.push(t); }
  }
  for (const oid of excluded) set.delete(oid);
  for (const boundary of boundaries) if (have.has(boundary)) unshallow.push(boundary);
  return { objects: [...set].map((oid) => repo.objects.get(oid)!).filter(Boolean), boundaries: boundaries.filter((x) => !have.has(x)), unshallow };
}
function oidTag(repo: Repository, oid: string): string | undefined {
  let obj = repo.objects.get(oid);
  while (obj?.type === 'tag') { const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1]; if (!target) break; oid = target; obj = repo.objects.get(oid); }
  return oid;
}
function advRefs(repo: Repository): Array<[string, string]> { return [...repo.refs].sort(([a], [b]) => a.localeCompare(b)); }
function serviceAdvertise(repo: Repository, service: string, v2: boolean): Buffer {
  if (v2 && service === 'git-upload-pack') return Buffer.concat([
    packet('version 2\n'), packet('agent=makefun-git-forge/1\n'), packet('ls-refs=unborn\n'),
    packet('fetch=shallow wait-for-done\n'), packet('server-option\n'), packet('object-format=sha1\n'), flush(),
  ]);
  const cap = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta atomic agent=makefun-git-forge/1'
    : 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=makefun-git-forge/1 symref=HEAD:refs/heads/main object-format=sha1';
  const refs = advRefs(repo);
  const lines: Buffer[] = [packet(`# service=${service}\n`), flush()];
  if (refs.length) refs.forEach(([ref, oid], i) => lines.push(packet(`${oid} ${ref}${i === 0 ? `\0${cap}` : ''}\n`)));
  else lines.push(packet(`${zero} capabilities^{}\0${cap}\n`));
  lines.push(flush()); return Buffer.concat(lines);
}
function handleLsRefs(repo: Repository, packets: Packet[]): Buffer {
  const commands = packets.filter((p): p is Extract<Packet, {kind:'data'}> => p.kind === 'data').map((p) => p.data.toString().trim());
  const prefixes = commands.filter((x) => x.startsWith('ref-prefix ')).map((x) => x.slice(11));
  const wantSym = commands.includes('symrefs'), wantPeel = commands.includes('peel');
  const lines: Buffer[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head && (!prefixes.length || prefixes.some((p) => 'HEAD'.startsWith(p)))) lines.push(packet(`${head} HEAD${wantSym ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  for (const [ref, oid] of advRefs(repo)) {
    if (prefixes.length && !prefixes.some((p) => ref.startsWith(p))) continue;
    const peeled = wantPeel ? oidTag(repo, oid) : undefined;
    lines.push(packet(`${oid} ${ref}${peeled && peeled !== oid ? ` peeled:${peeled}` : ''}\n`));
  }
  lines.push(flush()); return Buffer.concat(lines);
}
function sideband(pack: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < pack.length; at += 65515) out.push(packet(Buffer.concat([Buffer.from([band]), pack.subarray(at, at + 65515)])));
  return out;
}
function v2Fetch(repo: Repository, packets: Packet[]): Buffer {
  const lines = packets.filter((p): p is Extract<Packet, {kind:'data'}> => p.kind === 'data').map((p) => p.data.toString().replace(/\n$/, ''));
  const wants = lines.filter((x) => x.startsWith('want ')).map((x) => x.slice(5));
  const haves = new Set(lines.filter((x) => x.startsWith('have ')).map((x) => x.slice(5)));
  const shallow = new Set(lines.filter((x) => x.startsWith('shallow ')).map((x) => x.slice(8)));
  const depthString = lines.find((x) => x.startsWith('deepen '))?.slice(7);
  const depth = depthString ? Number(depthString) : undefined;
  const cacheKey = `v2|${wants.join(',')}|${[...haves].join(',')}|${[...shallow].join(',')}|${depth ?? ''}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) return cached;
  const result = reachable(repo, wants, haves, depth, shallow);
  const out: Buffer[] = [packet('acknowledgments\n'), packet('NAK\n'), flush()];
  if (depth !== undefined || shallow.size) {
    out.push(packet('shallow-info\n'));
    for (const oid of result.boundaries) out.push(packet(`shallow ${oid}\n`));
    for (const oid of result.unshallow) out.push(packet(`unshallow ${oid}\n`));
    out.push(flush());
  }
  if (result.objects.length) {
    const pack = writePack(result.objects);
    out.push(packet('packfile\n'), ...sideband(pack), flush());
  }
  const response = Buffer.concat(out);
  if (repo.fetchCache.size >= 32) repo.fetchCache.delete(repo.fetchCache.keys().next().value!);
  repo.fetchCache.set(cacheKey, response);
  return response;
}
function v0Fetch(repo: Repository, packets: Packet[]): Buffer {
  const lines = packets.filter((p): p is Extract<Packet, {kind:'data'}> => p.kind === 'data').map((p) => p.data.toString().replace(/\n$/, ''));
  const wants = lines.filter((x) => x.startsWith('want ')).map((x) => x.slice(5, 45));
  const haves = new Set(lines.filter((x) => x.startsWith('have ')).map((x) => x.slice(5)));
  const shallow = lines.filter((x) => x.startsWith('shallow ')).map((x) => x.slice(8));
  const d = lines.find((x) => x.startsWith('deepen '))?.slice(7), depth = d ? Number(d) : undefined;
  const cacheKey = `v0|${wants.join(',')}|${[...haves].join(',')}|${[...shallow].join(',')}|${depth ?? ''}`;
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) return cached;
  const result = reachable(repo, wants, haves, depth, new Set(shallow));
  const out: Buffer[] = [];
  for (const oid of result.boundaries) out.push(packet(`shallow ${oid}\n`));
  for (const oid of result.unshallow) out.push(packet(`unshallow ${oid}\n`));
  out.push(packet('NAK\n'));
  if (result.objects.length) out.push(...sideband(writePack(result.objects)));
  out.push(flush());
  const response = Buffer.concat(out);
  if (repo.fetchCache.size >= 32) repo.fetchCache.delete(repo.fetchCache.keys().next().value!);
  repo.fetchCache.set(cacheKey, response);
  return response;
}

function isAncestor(repo: Repository, oldOid: string, newOid: string): boolean {
  if (oldOid === zero) return true;
  const seen = new Set<string>(), stack = [newOid];
  while (stack.length) {
    const oid = stack.pop()!; if (oid === oldOid) return true; if (seen.has(oid)) continue; seen.add(oid);
    const obj = repo.objects.get(oid); if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}
function receive(repo: Repository, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const endCmd = packets.find((p) => p.kind === 'flush')?.end ?? 0;
  const commandPackets = packets.filter((p) => p.kind === 'data' && p.end <= endCmd);
  let packStart = endCmd;
  const commands = commandPackets.map((p) => {
    const text = p.kind === 'data' ? p.data.toString().replace(/\n$/, '') : '';
    const plain = text.split('\0')[0]!;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(plain);
    if (!m) throw new Error('bad receive-pack command');
    return { old: m[1]!, next: m[2]!, ref: m[3]! };
  });
  if (!commands.length) throw new Error('missing receive-pack commands');
  const packAt = endCmd;
  let incoming = new Map<string, GitObject>();
  if (body.toString('ascii', packAt, packAt + 4) === 'PACK') incoming = readPack(body.subarray(packAt), repo);
  let addedObject = false;
  for (const [oid, object] of incoming) if (!repo.objects.has(oid)) {
    repo.objects.set(oid, object);
    addedObject = true;
  }
  if (addedObject) repo.fetchCache.clear();
  const statuses: string[] = [];
  for (const c of commands) {
    const actual = repo.refs.get(c.ref) ?? zero;
    let reason = '';
    if (actual !== c.old) reason = 'stale info';
    else if (!c.ref.startsWith('refs/heads/') && !c.ref.startsWith('refs/tags/')) reason = 'deny updating a hidden ref';
    else if (c.next !== zero && !repo.objects.has(c.next)) reason = 'unpacker error';
    else if (c.ref.startsWith('refs/heads/') && c.next !== zero && actual !== zero && !isAncestor(repo, actual, c.next)) reason = 'non-fast-forward';
    if (reason) statuses.push(`ng ${c.ref} ${reason}\n`);
    else {
      if (c.next === zero) repo.refs.delete(c.ref); else repo.refs.set(c.ref, c.next);
      statuses.push(`ok ${c.ref}\n`);
    }
  }
  const report = Buffer.concat([packet(`unpack ${body.toString('ascii', packAt, packAt + 4) === 'PACK' || commands.every((c) => c.next === zero) ? 'ok' : incoming.size || commands.some((c) => c.next !== zero && repo.objects.has(c.next)) ? 'ok' : 'unpacker error'}\n`), ...statuses.map(packet), flush()]);
  return Buffer.concat(sideband(report));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }); res.end(text);
}
export function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, store: ForgeStore, token: string, body: Buffer | undefined): boolean {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]!), name = decodeURIComponent(m[2]!), endpoint = m[3]!;
  const repo = store.getRepo(owner, name);
  if (!repo) { jsonError(res, 404, 'Not Found'); return true; }
  if (req.headers.authorization !== `Bearer ${token}` || !token) { jsonError(res, 401, 'Requires authentication'); return true; }
  try {
    if (endpoint === 'info/refs' && req.method === 'GET') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { jsonError(res, 400, 'Unsupported git service'); return true; }
      const v2 = service === 'git-upload-pack' && String(req.headers['git-protocol'] ?? '').includes('version=2');
      const bytes = serviceAdvertise(repo, service, v2);
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache', 'content-length': bytes.length }); res.end(bytes); return true;
    }
    if (endpoint === 'git-upload-pack' && req.method === 'POST') {
      const packets = parsePackets(body ?? Buffer.alloc(0));
      const v2 = String(req.headers['git-protocol'] ?? '').includes('version=2');
      const bytes = v2
        ? (packets.some((p) => p.kind === 'data' && p.data.toString().startsWith('command=ls-refs')) ? handleLsRefs(repo, packets) : v2Fetch(repo, packets))
        : v0Fetch(repo, packets);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': bytes.length }); res.end(bytes); return true;
    }
    if (endpoint === 'git-receive-pack' && req.method === 'POST') {
      const bytes = receive(repo, body ?? Buffer.alloc(0));
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache', 'content-length': bytes.length }); res.end(bytes); return true;
    }
    jsonError(res, 405, 'Method Not Allowed'); return true;
  } catch {
    // A malformed pkt-line must not poison the server or its repository state.
    jsonError(res, 400, 'Invalid git protocol request'); return true;
  }
}
