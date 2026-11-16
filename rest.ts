import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree, type ForgeStore, type Repository, type Issue, type Pull } from './store.ts';

type Json = Record<string, unknown>;
const jsonType = 'application/json; charset=utf-8';
const viewerLogin = 'adaiversen';
const err = (res: ServerResponse, status: number, message: string): void => send(res, status, { message });
const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void => {
  if (status === 204) { res.writeHead(status, headers); res.end(); return; }
  const text = `${JSON.stringify(body ?? {})}\n`;
  res.writeHead(status, { 'content-type': jsonType, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};
const sendBuffer = (res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void => {
  res.writeHead(status, { 'content-type': jsonType, 'content-length': body.length, ...headers });
  res.end(body);
};
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const dec = (v: string): string => { try { return decodeURIComponent(v); } catch { return v; } };
const issueJson = (i: Issue, owner: string, repo: string): Json => ({
  id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
  user: { login: owner, id: 1, type: 'User' }, labels: i.labels.map((name) => ({ name })),
  created_at: i.created_at, updated_at: i.updated_at, comments: i.comments.length,
  html_url: `http://github.invalid/${owner}/${repo}/issues/${i.number}`,
});
const pullJson = (p: Pull, owner: string, repo: string): Json => ({
  id: p.id, number: p.number, title: p.title, body: p.body, state: p.state, merged: p.merged,
  head: { ref: p.head, sha: p.headSha, label: `${owner}:${p.head}`, repo: { full_name: `${owner}/${repo}` } },
  base: { ref: p.base, sha: p.baseSha, label: `${owner}:${p.base}`, repo: { full_name: `${owner}/${repo}` } },
  created_at: p.created_at, merged_at: p.merged_at, merge_commit_sha: p.merge_commit_sha,
  draft: false, mergeable: true, comments: 0,
});
const repoJson = (r: Repository): Json => ({
  id: r.id, node_id: `R_${r.id}`, name: r.name, full_name: `${r.owner}/${r.name}`,
  owner: { login: r.owner, id: 1, type: 'User' }, private: r.private, description: r.description,
  default_branch: r.defaultBranch, has_issues: true, has_issues_enabled: true,
  html_url: `http://github.invalid/${r.owner}/${r.name}`,
});
const issueResponseCache = new WeakMap<Issue, { updatedAt: string; body: Buffer }>();
const parseBody = (body: Buffer | undefined): Json => {
  if (!body?.length) return {};
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (!isObj(parsed)) throw new Error('JSON body must be an object');
  return parsed;
};

function commitHistory(repo: Repository, sha: string | undefined): Json[] {
  if (!sha) return [];
  const out: Json[] = [], seen = new Set<string>(), stack = [sha];
  while (stack.length && out.length < 100) {
    const oid = stack.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    out.push({ sha: oid, node_id: `C_${oid}`, commit: { message: commit.message.replace(/\n$/, ''), tree: { sha: commit.tree }, parents: commit.parents.map((x) => ({ sha: x })) } });
    stack.push(...commit.parents);
  }
  return out;
}

function treePath(store: ForgeStore, repo: Repository, ref: string, path: string): { oid: string; type: 'blob' | 'tree' } | undefined {
  const tip = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
  const commit = tip ? repo.objects.get(tip) : undefined;
  if (!commit || commit.type !== 'commit') return undefined;
  let oid = parseCommit(commit.data).tree;
  if (path === '') return { oid, type: 'tree' };
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    oid = entry.oid;
    if (i < parts.length - 1 && entry.mode !== '40000' && entry.mode !== '040000') return undefined;
    if (i === parts.length - 1) return { oid, type: entry.mode === '40000' || entry.mode === '040000' ? 'tree' : 'blob' };
  }
  return undefined;
}

function branchSha(repo: Repository, branch: string): string | undefined { return repo.refs.get(`refs/heads/${branch}`); }

export function handleRest(
  req: IncomingMessage, res: ServerResponse, url: URL, store: ForgeStore, token: string,
  requestId: string, body: Buffer | undefined,
): boolean {
  const path = url.pathname;
  if (!path.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const headers = { 'x-github-request-id': requestId };
  const sendR = (status: number, value?: unknown, extra: Record<string, string> = {}): void => send(res, status, value, { ...headers, ...extra });
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendR(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return true;
  }
  if (method === 'GET' && path === '/api/v3/healthz') { sendR(200, { ok: true }); return true; }
  const auth = req.headers.authorization === `Bearer ${token}` && token !== '';
  if (!auth) { sendR(401, { message: 'Requires authentication' }); return true; }
  if (method === 'GET') {
    const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    if (match) {
      const owner = dec(match[1]!), name = dec(match[2]!), number = Number(match[3]);
      const repo = store.getRepo(owner, name), issue = repo?.issuesByNumber.get(number);
      if (!repo || owner !== viewerLogin || !issue) { sendR(404, { message: 'Not Found' }); return true; }
      let cached = issueResponseCache.get(issue);
      if (cached?.updatedAt !== issue.updated_at) {
        const body = Buffer.from(`${JSON.stringify(issueJson(issue, owner, name))}\n`);
        cached = { updatedAt: issue.updated_at, body };
        issueResponseCache.set(issue, cached);
      }
      sendBuffer(res, 200, cached.body, headers);
      return true;
    }
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendR(200, { login: viewerLogin, id: 1, name: 'Ada Iversen', type: 'User' }); return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') { sendR(200, { installed_version: '3.12.0' }); return true; }
  if (method === 'GET' && path === '/api/v3/rate_limit') {
    sendR(200, { resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 }, search: { limit: 30, remaining: 30, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } }); return true;
  }
  let input: Json;
  try { input = parseBody(body); } catch { sendR(400, { message: 'Invalid JSON body' }); return true; }
  const parts = path.slice('/api/v3/'.length).split('/').map(dec);

  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name) { sendR(422, { message: 'Repository name is required' }); return true; }
      const repo = store.createRepo(viewerLogin, name, { private: input.private === true, description: typeof input.description === 'string' ? input.description : '' });
      if (!repo) { sendR(422, { message: 'Repository already exists' }); return true; }
      sendR(201, repoJson(repo)); return true;
    }
    if (method === 'GET') {
      const all = [...store.repos.values()].filter((r) => r.owner === viewerLogin);
      const per = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      const items = all.slice((page - 1) * per, page * per).map(repoJson);
      const links: string[] = [];
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      if (page > 1) links.push(`<${origin}${path}?per_page=${per}&page=${page - 1}>; rel="prev"`);
      if (page * per < all.length) links.push(`<${origin}${path}?per_page=${per}&page=${page + 1}>; rel="next"`);
      if (links.length) sendR(200, items, { link: links.join(', ') }); else sendR(200, items);
      return true;
    }
  }
  if (parts[0] !== 'repos' || parts.length < 3) { sendR(404, { message: 'Not Found' }); return true; }
  const owner = parts[1]!, name = parts[2]!, repo = store.getRepo(owner, name);
  if (!repo || owner !== viewerLogin) { sendR(404, { message: 'Not Found' }); return true; }
  if (parts.length === 3) {
    if (method === 'GET') { sendR(200, repoJson(repo)); return true; }
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      sendR(200, repoJson(repo)); return true;
    }
    if (method === 'DELETE') { store.repos.delete(store.key(owner, name)); sendR(204); return true; }
  }
  const sub = parts[3];
  if (sub === 'branches' && parts.length > 4 && method === 'GET') {
    const branch = parts.slice(4).join('/'), sha = branchSha(repo, branch);
    if (!sha) sendR(404, { message: 'Branch not found' }); else sendR(200, { name: branch, commit: { sha } });
    return true;
  }
  if (sub === 'branches' && method === 'GET') {
    const branches = [...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha } }));
    sendR(200, branches); return true;
  }
  if (sub === 'git' && parts[4] === 'refs') {
    if (method === 'POST' && parts.length === 5) {
      const ref = typeof input.ref === 'string' ? input.ref : '', sha = typeof input.sha === 'string' ? input.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { sendR(422, { message: 'Invalid ref or object' }); return true; }
      if (repo.refs.has(ref)) { sendR(422, { message: 'Reference already exists' }); return true; }
      repo.refs.set(ref, sha); sendR(201, { ref, object: { sha, type: 'commit' } }); return true;
    }
    if (method === 'GET') {
      const ref = parts.slice(5).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref.startsWith('heads/') || ref.startsWith('tags/') ? '' : 'heads/'}${ref}`;
      const sha = repo.refs.get(full);
      if (!sha) sendR(404, { message: 'Reference not found' }); else sendR(200, { ref: full, object: { sha, type: repo.objects.get(sha)?.type } });
      return true;
    }
  }
  if (sub === 'commits' && method === 'GET') {
    const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
    sendR(200, commitHistory(repo, repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`))); return true;
  }
  if (sub === 'contents') {
    const filePath = parts.slice(4).join('/');
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const found = treePath(store, repo, ref, filePath);
    if (method === 'GET') {
      if (!found) { sendR(404, { message: 'Not Found' }); return true; }
      const object = repo.objects.get(found.oid);
      if (found.type === 'blob' && object?.type === 'blob') {
        sendR(200, { type: 'file', encoding: 'base64', content: object.data.toString('base64'), sha: found.oid, size: object.data.length, name: filePath.split('/').at(-1), path: filePath }); return true;
      }
      if (object?.type === 'tree') {
        sendR(200, parseTree(object.data).map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: filePath ? `${filePath}/${e.name}` : e.name, sha: e.oid, size: repo.objects.get(e.oid)?.data.length ?? 0 }))); return true;
      }
      sendR(404, { message: 'Not Found' }); return true;
    }
    if (method === 'PUT') {
      const current = found?.type === 'blob' ? found.oid : undefined;
      const suppliedSha = typeof input.sha === 'string' ? input.sha.toLowerCase() : undefined;
      if (current && suppliedSha !== current) { sendR(409, { message: 'sha does not match the current file' }); return true; }
      if (!current && suppliedSha) { sendR(409, { message: 'sha does not match the current file' }); return true; }
      const bytes = typeof input.content === 'string' ? Buffer.from(input.content.replace(/\s/g, ''), 'base64') : Buffer.alloc(0);
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      const result = store.writeFile(repo, filePath, bytes, String(input.message ?? 'Update file'), branch);
      sendR(current ? 200 : 201, { content: { name: filePath.split('/').at(-1), path: filePath, sha: result.blob, size: bytes.length, encoding: 'base64' }, commit: { sha: result.commit, message: input.message ?? '', tree: { sha: store.headTree(repo, branch) } } }); return true;
    }
    if (method === 'DELETE') {
      if (!found) { sendR(404, { message: 'Not Found' }); return true; }
      if (!found || found.type !== 'blob' || input.sha !== found.oid) { sendR(404, { message: 'Not Found' }); return true; }
      const commit = store.deleteFile(repo, filePath, String(input.message ?? 'Delete file'), typeof input.branch === 'string' ? input.branch : repo.defaultBranch);
      if (!commit) sendR(404, { message: 'Not Found' }); else sendR(200, { commit: { sha: commit } });
      return true;
    }
  }
  if (sub === 'labels' && method === 'POST') {
    const label = typeof input.name === 'string' ? input.name : '';
    if (!label) { sendR(422, { message: 'Label name is required' }); return true; }
    if (repo.labels.has(label)) { sendR(422, { message: 'Label already exists' }); return true; }
    const color = typeof input.color === 'string' ? input.color : 'ededed';
    repo.labels.set(label, color); sendR(201, { id: store.allocId(), name: label, color }); return true;
  }
  if (sub === 'issues') {
    if (parts.length === 4 && method === 'POST') {
      const title = typeof input.title === 'string' ? input.title : '', labels = Array.isArray(input.labels) ? input.labels.filter((x): x is string => typeof x === 'string') : [];
      if (!title) { sendR(422, { message: 'title is required' }); return true; }
      if (labels.some((x) => !repo.labels.has(x))) { sendR(422, { message: 'Validation Failed: label does not exist' }); return true; }
      const now = store.now();
      const issue: Issue = { id: store.allocId(), number: repo.nextIssue++, title, body: String(input.body ?? ''), state: 'open', labels, created_at: now, updated_at: now, comments: [] };
      repo.issues.push(issue); repo.issuesByNumber.set(issue.number, issue); sendR(201, issueJson(issue, owner, name)); return true;
    }
    if (parts.length === 4 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      list = [...list].sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      const per = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? 30) || 30));
      sendR(200, list.slice((page - 1) * per, page * per).map((i) => issueJson(i, owner, name))); return true;
    }
    const n = Number(parts[4]), issue = repo.issuesByNumber.get(n);
    if (!issue) { sendR(404, { message: 'Not Found' }); return true; }
    if (parts[5] === 'comments') {
      if (method === 'GET') { sendR(200, issue.comments.map((c) => ({ ...c, user: { login: owner }, created_at: issue.created_at }))); return true; }
      if (method === 'POST') {
        const comment = { id: store.allocId(), body: String(input.body ?? '') };
        issue.comments.push(comment); issue.updated_at = store.now(); sendR(201, comment); return true;
      }
    }
    if (parts.length === 5 && method === 'GET') { sendR(200, issueJson(issue, owner, name)); return true; }
    if (parts.length === 5 && method === 'PATCH') {
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
      if (Array.isArray(input.labels)) {
        const labels = input.labels.filter((x): x is string => typeof x === 'string');
        if (labels.some((x) => !repo.labels.has(x))) { sendR(422, { message: 'Validation Failed: label does not exist' }); return true; }
        issue.labels = labels;
      }
      issue.updated_at = store.now(); sendR(200, issueJson(issue, owner, name)); return true;
    }
  }
  if (sub === 'pulls') {
    if (parts.length === 4 && method === 'POST') {
      const head = typeof input.head === 'string' ? input.head : '', base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
      const headSha = branchSha(repo, head), baseSha = branchSha(repo, base);
      if (!headSha || !baseSha) { sendR(422, { message: 'Head or base branch not found' }); return true; }
      if (repo.pulls.some((p) => p.head === head && p.state === 'open')) { sendR(422, { message: 'A pull request already exists for this branch' }); return true; }
      const headTree = store.headTree(repo, head), baseTree = store.headTree(repo, base);
      const headFiles = headTree ? store.treeFiles(repo, headTree) : new Map();
      const baseFiles = baseTree ? store.treeFiles(repo, baseTree) : new Map();
      const changed = [...headFiles].filter(([p, v]) => baseFiles.get(p)?.oid !== v.oid).map(([p]) => p);
      const now = store.now();
      const pull: Pull = { id: store.allocId(), number: repo.nextPull++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', head, base, headSha, baseSha, merged: false, merged_at: null, merge_commit_sha: null, created_at: now, changed };
      repo.pulls.push(pull); sendR(201, pullJson(pull, owner, name)); return true;
    }
    if (parts.length === 4 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      sendR(200, repo.pulls.filter((p) => state === 'all' || p.state === state).map((p) => pullJson(p, owner, name))); return true;
    }
    const n = Number(parts[4]), pull = repo.pulls.find((p) => p.number === n);
    if (!pull) { sendR(404, { message: 'Not Found' }); return true; }
    if (parts[5] === 'files' && method === 'GET') {
      const baseTree = store.headTree(repo, pull.base), headTree = store.headTree(repo, pull.head);
      const b = baseTree ? store.treeFiles(repo, baseTree) : new Map(), h = headTree ? store.treeFiles(repo, headTree) : new Map();
      const paths = new Set([...b.keys(), ...h.keys()]);
      sendR(200, [...paths].filter((p) => b.get(p)?.oid !== h.get(p)?.oid).map((filename) => ({ filename, status: b.has(filename) ? 'modified' : 'added', additions: 1, deletions: b.has(filename) ? 1 : 0, changes: b.has(filename) ? 2 : 1 }))); return true;
    }
    if (parts[5] === 'merge' && method === 'PUT') {
      if (pull.merged) { sendR(405, { message: 'Pull request was already merged' }); return true; }
      const current = branchSha(repo, pull.base), head = branchSha(repo, pull.head);
      if (!current || !head) { sendR(405, { message: 'Pull request cannot be merged' }); return true; }
      const currentTree = store.headTree(repo, pull.base);
      const baseObject = repo.objects.get(pull.baseSha);
      const originalTree = baseObject?.type === 'commit' ? parseCommit(baseObject.data).tree : currentTree;
      const baseFiles = currentTree ? store.treeFiles(repo, currentTree) : new Map();
      const originalFiles = originalTree ? store.treeFiles(repo, originalTree) : new Map();
      const headTree = store.headTree(repo, pull.head), headFiles = headTree ? store.treeFiles(repo, headTree) : new Map();
      for (const p of pull.changed) if (baseFiles.get(p)?.oid !== originalFiles.get(p)?.oid && baseFiles.get(p)?.oid !== headFiles.get(p)?.oid) {
        sendR(405, { message: 'Merge conflict' }); return true;
      }
      const tree = headTree ?? currentTree!;
      const merge = store.commit(repo, tree, [current, head], `Merge pull request #${n}`);
      repo.refs.set(`refs/heads/${pull.base}`, merge);
      pull.state = 'closed'; pull.merged = true; pull.merged_at = store.now(); pull.merge_commit_sha = merge;
      sendR(200, { sha: merge, merged: true, message: 'Pull Request successfully merged' }); return true;
    }
    if (parts.length === 5 && method === 'GET') { sendR(200, pullJson(pull, owner, name)); return true; }
    if (parts.length === 5 && method === 'PATCH') {
      if (typeof input.title === 'string') pull.title = input.title;
      if (typeof input.body === 'string') pull.body = input.body;
      if (input.state === 'open' || input.state === 'closed') pull.state = input.state;
      sendR(200, pullJson(pull, owner, name)); return true;
    }
  }
  sendR(404, { message: 'Not Found' }); return true;
}
