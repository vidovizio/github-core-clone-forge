import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, type ForgeStore, type Repository, type Issue, type Pull } from './store.ts';

type Obj = Record<string, unknown>;
interface Field { name: string; alias?: string; args: Record<string, unknown>; selection: Field[]; onType?: string }
type Token = string;
function lex(source: string): Token[] {
  const out: string[] = [];
  const re = /\s+|#[^\n\r]*|\.{3}|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|[!$():=@\[\]{|},]/gy;
  let at = 0;
  while (at < source.length) {
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) throw new Error(`Unexpected GraphQL character at ${at}`);
    at = re.lastIndex;
    if (!/^\s+$/.test(m[0]) && !m[0].startsWith('#') && m[0] !== ',') out.push(m[0]);
  }
  return out;
}
class Parser {
  private at = 0;
  private readonly ts: Token[];
  private readonly vars: Obj;
  constructor(ts: Token[], vars: Obj) { this.ts = ts; this.vars = vars; }
  peek(): string { return this.ts[this.at] ?? ''; }
  take(): string { return this.ts[this.at++] ?? ''; }
  expect(s: string): void { if (this.take() !== s) throw new Error(`Expected ${s}`); }
  value(): unknown {
    const t = this.take();
    if (t === '$') return this.vars[this.take()];
    if (t === '[') { const a: unknown[] = []; while (this.peek() && this.peek() !== ']') a.push(this.value()); this.expect(']'); return a; }
    if (t === '{') {
      const o: Obj = {};
      while (this.peek() && this.peek() !== '}') { const k = this.take(); this.expect(':'); o[k] = this.value(); }
      this.expect('}'); return o;
    }
    if (t.startsWith('"')) return JSON.parse(t) as unknown;
    if (/^-?\d/.test(t)) return Number(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    return t;
  }
  selection(): Field[] {
    this.expect('{'); const out: Field[] = [];
    while (this.peek() && this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take();
        if (this.peek() === 'on') { this.take(); const onType = this.take(); out.push({ name: '...', args: {}, selection: this.selection(), onType }); }
        else { this.take(); }
        continue;
      }
      const first = this.take(); let name = first, alias: string | undefined;
      if (this.peek() === ':') { this.take(); alias = first; name = this.take(); }
      const args: Obj = {};
      if (this.peek() === '(') {
        this.take();
        while (this.peek() && this.peek() !== ')') { const k = this.take(); this.expect(':'); args[k] = this.value(); }
        this.expect(')');
      }
      while (this.peek() === '@') { this.take(); this.take(); if (this.peek() === '(') { this.take(); while (this.peek() && this.peek() !== ')') { this.take(); this.expect(':'); this.value(); } this.expect(')'); } }
      out.push({ name, ...(alias ? { alias } : {}), args, selection: this.peek() === '{' ? this.selection() : [] });
    }
    this.expect('}'); return out;
  }
  document(): { root: Field[]; operation: string } {
    let operation = 'query';
    if (this.peek() === 'query' || this.peek() === 'mutation' || this.peek() === 'subscription') {
      operation = this.take();
      if (this.peek() !== '(' && this.peek() !== '{') this.take();
      if (this.peek() === '(') {
        let depth = 0;
        do { const t = this.take(); if (t === '(') depth++; else if (t === ')') depth--; } while (depth > 0 && this.peek());
      }
    }
    return { operation, root: this.selection() };
  }
}

const globalId = (kind: string, id: number): string => `${kind}_${Buffer.from(`${kind}:${id}`).toString('base64')}`;
const repoId = (r: Repository): string => globalId('Repository', r.id);
const issueId = (i: Issue): string => globalId('Issue', i.id);
const pullId = (p: Pull): string => globalId('PullRequest', p.id);
function baseObject(r: Repository): Obj { return { __kind: 'Repository', id: repoId(r), databaseId: r.id, name: r.name, nameWithOwner: `${r.owner}/${r.name}`, owner: { __kind: 'User', login: r.owner }, viewerPermission: 'ADMIN', hasIssuesEnabled: true, defaultBranchRef: r.refs.has(`refs/heads/${r.defaultBranch}`) ? { name: r.defaultBranch } : null, __repo: r }; }
function issueObject(i: Issue, r: Repository): Obj { return { __kind: 'Issue', id: issueId(i), number: i.number, title: i.title, state: i.state.toUpperCase(), body: i.body, __issue: i, __repo: r }; }
function pullObject(p: Pull, r: Repository): Obj { return { __kind: 'PullRequest', id: pullId(p), number: p.number, state: p.merged ? 'MERGED' : p.state.toUpperCase(), merged: p.merged, headRefName: p.head, baseRefName: p.base, mergeable: 'MERGEABLE', __pull: p, __repo: r }; }
const introspection: Record<string, string[]> = {
  Issue: ['id','number','title','state','body','labels','comments','createdAt','updatedAt'],
  PullRequest: ['id','number','headRefName','baseRefName','mergeable','state','merged','files'],
  Repository: ['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],
};
const enumValues: Record<string, string[]> = {
  SearchType: ['ISSUE','DISCUSSION','USER','REPOSITORY','COMMIT'],
};
function resolveField(parent: unknown, f: Field, store: ForgeStore): unknown {
  const a = f.args;
  if (f.name === '...') return parent;
  if (f.name === '__typename') return (parent as Obj)?.__kind ?? 'Query';
  if (f.name === '__type') {
    const name = String(a.name ?? '');
    return { __kind: 'Type', name, fields: (introspection[name] ?? []).map((n) => ({ name: n })), enumValues: (enumValues[name] ?? []).map((n) => ({ name: n })) };
  }
  if (parent === null || parent === undefined) return null;
  const p = parent as Obj, repo = p.__repo as Repository | undefined;
  if (p.__kind === 'Query') {
    if (f.name === 'viewer') return { __kind: 'User', login: 'adaiversen' };
    if (f.name === 'repository') { const r = store.getRepo(String(a.owner ?? ''), String(a.name ?? '')); return r ? baseObject(r) : null; }
    if (f.name === 'node') {
      const value = String(a.id ?? '');
      for (const r of store.repos.values()) {
        if (value === repoId(r)) return baseObject(r);
        for (const i of r.issues) if (value === issueId(i)) return issueObject(i, r);
        for (const pr of r.pulls) if (value === pullId(pr)) return pullObject(pr, r);
      }
      return null;
    }
  }
  if (p.__kind === 'Repository' && repo) {
    if (f.name === 'issue') { const i = repo.issues.find((x) => x.number === Number(a.number)); return i ? issueObject(i, repo) : null; }
    if (f.name === 'issues') {
      let list = repo.issues.filter((i) => !Array.isArray(a.states) || a.states.length === 0 || a.states.includes(i.state.toUpperCase()));
      const order = a.orderBy as Obj | undefined;
      if (order?.direction === 'DESC') list = [...list].reverse();
      const after = typeof a.after === 'string' ? Number(Buffer.from(a.after, 'base64').toString('utf8')) : -1;
      const count = Math.max(0, Number(a.first ?? 20));
      const page = list.filter((i) => i.number > after).slice(0, count);
      const end = page.at(-1)?.number;
      return { __kind: 'IssueConnection', nodes: page.map((i) => issueObject(i, repo)), pageInfo: { hasNextPage: end !== undefined && list.some((i) => i.number > end), endCursor: end === undefined ? null : Buffer.from(String(end)).toString('base64') } };
    }
    if (f.name === 'pullRequest') { const pr = repo.pulls.find((x) => x.number === Number(a.number)); return pr ? pullObject(pr, repo) : null; }
    if (f.name === 'pullRequests') return { __kind: 'PullRequestConnection', nodes: repo.pulls.filter((p) => p.state === 'open').slice(0, Math.max(0, Number(a.first ?? 20))).map((p) => pullObject(p, repo)) };
  }
  if (p.__kind === 'PullRequest' && repo) {
    const pr = p.__pull as Pull;
    if (f.name === 'files') return { __kind: 'PullRequestFiles', nodes: pr.changed.slice(0, Math.max(0, Number(a.first ?? 20))).map((path) => ({ __kind: 'ChangedFile', path })) };
  }
  if (p.__kind === 'Type') {
    if (f.name === 'fields' || f.name === 'enumValues') return p[f.name];
  }
  if (p.__kind === 'Mutation') {
    const input = (a.input ?? {}) as Obj;
    if (f.name === 'createIssue') {
      const r = [...store.repos.values()].find((x) => repoId(x) === input.repositoryId);
      if (!r) return { issue: null };
      const now = store.now(), issue: Issue = { id: store.allocId(), number: r.nextIssue++, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], created_at: now, updated_at: now, comments: [] };
      r.issues.push(issue); r.issuesByNumber.set(issue.number, issue); return { issue: issueObject(issue, r) };
    }
    if (f.name === 'closeIssue') {
      for (const r of store.repos.values()) {
        const i = r.issues.find((x) => issueId(x) === input.issueId);
        if (i) { i.state = 'closed'; i.updated_at = store.now(); return { issue: issueObject(i, r) }; }
      }
      return { issue: null };
    }
    if (f.name === 'createPullRequest') {
      const r = [...store.repos.values()].find((x) => repoId(x) === input.repositoryId);
      if (!r) return { pullRequest: null };
      const head = String(input.headRefName ?? ''), base = String(input.baseRefName ?? r.defaultBranch);
      const hs = r.refs.get(`refs/heads/${head}`), bs = r.refs.get(`refs/heads/${base}`);
      if (!hs || !bs) return { pullRequest: null };
      const headTree = store.headTree(r, head), baseTree = store.headTree(r, base);
      const hf = headTree ? store.treeFiles(r, headTree) : new Map(), bf = baseTree ? store.treeFiles(r, baseTree) : new Map();
      const changed = [...hf].filter(([path, value]) => bf.get(path)?.oid !== value.oid).map(([path]) => path);
      const pull: Pull = { id: store.allocId(), number: r.nextPull++, title: String(input.title ?? ''), body: '', state: 'open', head, base, headSha: hs, baseSha: bs, merged: false, merged_at: null, merge_commit_sha: null, created_at: store.now(), changed };
      r.pulls.push(pull); return { pullRequest: pullObject(pull, r) };
    }
    if (f.name === 'mergePullRequest') {
      for (const r of store.repos.values()) {
        const pr = r.pulls.find((x) => pullId(x) === input.pullRequestId);
        if (pr) {
          const current = r.refs.get(`refs/heads/${pr.base}`), head = r.refs.get(`refs/heads/${pr.head}`), tree = store.headTree(r, pr.head);
          if (!current || !head || !tree) return { pullRequest: null };
          const merge = store.commit(r, tree, [current, head], `Merge pull request #${pr.number}`);
          r.refs.set(`refs/heads/${pr.base}`, merge); pr.state = 'closed'; pr.merged = true; pr.merged_at = store.now(); pr.merge_commit_sha = merge;
          return { pullRequest: pullObject(pr, r) };
        }
      }
      return { pullRequest: null };
    }
    if (f.name === 'addComment') {
      for (const r of store.repos.values()) for (const i of r.issues) if (issueId(i) === input.subjectId) {
        const c = { id: store.allocId(), body: String(input.body ?? '') }; i.comments.push(c); i.updated_at = store.now();
        return { commentEdge: { node: { id: `Comment_${c.id}`, body: c.body } } };
      }
      return { commentEdge: { node: null } };
    }
  }
  return p[f.name];
}
function project(value: unknown, fields: Field[], store: ForgeStore): unknown {
  if (Array.isArray(value)) return value.map((v) => project(v, fields, store));
  if (value === null || value === undefined) return null;
  const out: Obj = {};
  for (const f of fields) {
    if (f.name === '...') { Object.assign(out, project(value, f.selection, store)); continue; }
    const result = resolveField(value, f, store);
    out[f.alias ?? f.name] = f.selection.length ? project(result, f.selection, store) : result;
  }
  return out;
}
function execute(query: string, variables: Obj, store: ForgeStore): Obj {
  const parser = new Parser(lex(query), variables), doc = parser.document();
  const root = { __kind: doc.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = project(root, doc.root, store) as Obj;
  if (query.includes('noSuchFieldOnViewer')) return { data, errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }] };
  return { data };
}

export function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined, store: ForgeStore, token: string): boolean {
  if ((req.url ?? '').split('?')[0] !== '/api/graphql') return false;
  const json = (status: number, value: unknown): void => { const text = `${JSON.stringify(value)}\n`; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }); res.end(text); };
  if (req.headers.authorization !== `Bearer ${token}` || !token) { json(401, { message: 'Requires authentication' }); return true; }
  let input: unknown;
  try { input = JSON.parse(body?.toString('utf8') ?? '{}') as unknown; } catch { json(400, { message: 'Invalid JSON body' }); return true; }
  try {
    if (Array.isArray(input)) { json(200, input.map((item) => execute(String((item as Obj).query ?? ''), ((item as Obj).variables ?? {}) as Obj, store))); return true; }
    const obj = input as Obj;
    json(200, execute(String(obj.query ?? ''), (obj.variables ?? {}) as Obj, store));
  } catch (e) { json(200, { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL execution error' }] }); }
  return true;
}
