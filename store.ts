import { createHash } from 'node:crypto';

export type GitType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: GitType; data: Buffer }
export interface GitEntry { mode: string; name: string; oid: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; created_at: string; updated_at: string; comments: { id: number; body: string }[];
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string; merged: boolean;
  merged_at: string | null; merge_commit_sha: string | null; created_at: string;
  changed: string[];
}
export interface Repository {
  id: number; owner: string; name: string; private: boolean; description: string;
  defaultBranch: string; refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Issue[]; issuesByNumber: Map<number, Issue>; pulls: Pull[]; labels: Map<string, string>;
  fetchCache: Map<string, Buffer>;
  nextIssue: number; nextPull: number;
}

const hex = (b: Buffer): string => b.toString('hex');
export const hashObject = (type: GitType, data: Buffer): string =>
  createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
export const zeroOid = '0'.repeat(40);

export function treeData(entries: readonly GitEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  return Buffer.concat(sorted.map((e) => Buffer.concat([
    Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex'),
  ])));
}

export function parseTree(data: Buffer): GitEntry[] {
  const out: GitEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(32, at), nul = data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({ mode: data.toString('ascii', at, space), name: data.toString('utf8', space + 1, nul), oid: hex(data.subarray(nul + 1, nul + 21)) });
    at = nul + 21;
  }
  return out;
}

export interface CommitData { tree: string; parents: string[]; author: string; committer: string; timestamp: number; message: string }
export function commitData(c: CommitData): Buffer {
  const when = `${c.timestamp} +0000`;
  const headers = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${c.author} ${when}`, `committer ${c.committer} ${when}`].join('\n');
  return Buffer.from(`${headers}\n\n${c.message.endsWith('\n') ? c.message : `${c.message}\n`}`);
}
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8'), sep = text.indexOf('\n\n'), head = text.slice(0, sep < 0 ? text.length : sep);
  const headers = head.split('\n'), tree = /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? '';
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
  const authorLine = headers.find((x) => x.startsWith('author '))?.slice(7) ?? '';
  const committerLine = headers.find((x) => x.startsWith('committer '))?.slice(10) ?? authorLine;
  const ts = / (-?\d+) [+-]\d{4}$/.exec(authorLine)?.[1] ?? '0';
  return { tree, parents, author: authorLine.replace(/ -?\d+ [+-]\d{4}$/, ''), committer: committerLine.replace(/ -?\d+ [+-]\d{4}$/, ''), timestamp: Number(ts), message: sep < 0 ? '' : text.slice(sep + 2) };
}

const baseInstant = Date.UTC(2026, 0, 1);
export class ForgeStore {
  readonly repos = new Map<string, Repository>();
  private nextRepo = 1;
  private nextItem = 1;
  private ticks = 0;

  now(): string {
    const value = new Date(baseInstant + this.ticks * 1000).toISOString();
    this.ticks += 1;
    return value;
  }
  allocId(): number { return this.nextItem++; }
  key(owner: string, name: string): string { return `${owner.toLowerCase()}/${name.toLowerCase()}`; }
  getRepo(owner: string, name: string): Repository | undefined { return this.repos.get(this.key(owner, name)); }
  createRepo(owner: string, name: string, input: { private?: boolean; description?: string }): Repository | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repository = {
      id: this.nextRepo++, owner, name, private: input.private ?? false, description: input.description ?? '',
      defaultBranch: 'main', refs: new Map(), objects: new Map(), issues: [], issuesByNumber: new Map(), pulls: [],
      labels: new Map(), fetchCache: new Map(), nextIssue: 1, nextPull: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }
  putObject(repo: Repository, type: GitType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }
  blob(repo: Repository, data: Buffer): string { return this.putObject(repo, 'blob', data); }
  tree(repo: Repository, entries: readonly GitEntry[]): string { return this.putObject(repo, 'tree', treeData(entries)); }
  commit(repo: Repository, tree: string, parents: string[], message: string): string {
    const when = Math.floor((baseInstant + this.ticks++ * 1000) / 1000);
    const author = 'Copilot <copilot@example.invalid>';
    return this.putObject(repo, 'commit', commitData({ tree, parents, author, committer: author, timestamp: when, message }));
  }
  treeFiles(repo: Repository, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const result = new Map<string, { oid: string; mode: string }>();
    const visit = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (entry.mode === '40000' || entry.mode === '040000') visit(entry.oid, name);
        else result.set(name, { oid: entry.oid, mode: entry.mode });
      }
    };
    visit(treeOid, prefix);
    return result;
  }
  headCommit(repo: Repository, branch = repo.defaultBranch): string | undefined { return repo.refs.get(`refs/heads/${branch}`); }
  headTree(repo: Repository, branch = repo.defaultBranch): string | undefined {
    const sha = this.headCommit(repo, branch), object = sha ? repo.objects.get(sha) : undefined;
    return object?.type === 'commit' ? parseCommit(object.data).tree : undefined;
  }
  writeFile(repo: Repository, path: string, bytes: Buffer, message: string, branch = repo.defaultBranch): { commit: string; blob: string; created: boolean } {
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const oldCommit = parent ? repo.objects.get(parent) : undefined;
    const oldTree = oldCommit?.type === 'commit' ? parseCommit(oldCommit.data).tree : undefined;
    const files = oldTree ? this.treeFiles(repo, oldTree) : new Map<string, { oid: string; mode: string }>();
    const blob = this.blob(repo, bytes);
    files.set(path, { oid: blob, mode: '100644' });
    const root: { files: Map<string, string>; dirs: Map<string, any> } = { files: new Map(), dirs: new Map() };
    for (const [file, value] of files) {
      const parts = file.split('/'); let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.dirs.get(part);
        if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(part, next); }
        node = next;
      }
      node.files.set(parts.at(-1)!, value.oid);
    }
    const build = (node: typeof root): string => {
      const entries: GitEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.tree(repo, entries);
    };
    const tree = build(root), commit = this.commit(repo, tree, parent ? [parent] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return { commit, blob, created: !files.has(path) };
  }
  deleteFile(repo: Repository, path: string, message: string, branch = repo.defaultBranch): string | null {
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const old = parent ? repo.objects.get(parent) : undefined;
    if (!old || old.type !== 'commit') return null;
    const files = this.treeFiles(repo, parseCommit(old.data).tree);
    if (!files.delete(path)) return null;
    const root: { files: Map<string, string>; dirs: Map<string, any> } = { files: new Map(), dirs: new Map() };
    for (const [file, value] of files) {
      const parts = file.split('/'); let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.dirs.get(part);
        if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(part, next); }
        node = next;
      }
      node.files.set(parts.at(-1)!, value.oid);
    }
    const build = (node: typeof root): string => this.tree(repo, [
      ...[...node.files].map(([name, oid]) => ({ mode: '100644', name, oid })),
      ...[...node.dirs].map(([name, sub]) => ({ mode: '40000', name, oid: build(sub) })),
    ]);
    const commit = this.commit(repo, build(root), [parent], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return commit;
  }
}

export function listCommits(repo: Repository, start: string | undefined): string[] {
  if (!start) return [];
  const out: string[] = [], seen = new Set<string>(), stack = [start];
  while (stack.length && out.length < 500) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid); out.push(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents.reverse());
  }
  return out;
}

export function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/\s/g, ''), 'base64');
}
