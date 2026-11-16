import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore, Issue, Pull } from './store.ts';

type Obj = Record<string, unknown>;
const tools = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and repository name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request between repository branches.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge an open pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'update_issue', description: 'Update an issue state or title.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' }, state: { type: 'string' } }, required: ['owner', 'repo', 'number'] } },
];
const rpcError = (id: unknown, code: number, message: string): Obj => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const asText = (value: unknown): Obj => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
const findRepo = (store: ForgeStore, a: Obj) => store.getRepo(String(a.owner ?? 'adaiversen'), String(a.repo ?? a.name ?? ''));
const branchTip = (repo: NonNullable<ReturnType<typeof findRepo>>, name: string): string | undefined => repo.refs.get(`refs/heads/${name}`);

function callTool(name: string, rawArgs: unknown, store: ForgeStore): { result?: Obj; error?: Obj } {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Obj : {};
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = tool.inputSchema.required as string[];
  if (required.some((key) => args[key] === undefined || args[key] === null || args[key] === '')) return { error: { code: -32602, message: `Missing required argument: ${required.find((key) => args[key] === undefined || args[key] === null || args[key] === '')}` } };
  if (name === 'create_repo') {
    const owner = String(args.owner ?? 'adaiversen'), repo = store.createRepo(owner, String(args.name), { description: String(args.description ?? ''), private: args.private === true });
    if (!repo) return { result: { ...asText({ message: 'Repository already exists' }), isError: true } };
    return { result: asText({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private }) };
  }
  const repo = findRepo(store, args);
  if (!repo) return { result: { ...asText({ message: 'Repository not found' }), isError: true } };
  if (name === 'get_repo') return { result: asText({ id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, default_branch: repo.defaultBranch }) };
  if (name === 'create_issue') {
    const now = store.now(), issue: Issue = { id: store.allocId(), number: repo.nextIssue++, title: String(args.title), body: String(args.body ?? ''), state: 'open', labels: [], created_at: now, updated_at: now, comments: [] };
    repo.issues.push(issue); repo.issuesByNumber.set(issue.number, issue); return { result: asText({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state }) };
  }
  if (name === 'list_issues') {
    const state = String(args.state ?? 'open');
    return { result: asText(repo.issues.filter((i) => state === 'all' || i.state === state).map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }))) };
  }
  if (name === 'create_pull_request') {
    const head = String(args.head), base = String(args.base), headSha = branchTip(repo, head), baseSha = branchTip(repo, base);
    if (!headSha || !baseSha) return { result: { ...asText({ message: 'Head or base branch not found' }), isError: true } };
    const headTree = store.headTree(repo, head), baseTree = store.headTree(repo, base);
    const hf = headTree ? store.treeFiles(repo, headTree) : new Map(), bf = baseTree ? store.treeFiles(repo, baseTree) : new Map();
    const changed = [...hf].filter(([p, v]) => bf.get(p)?.oid !== v.oid).map(([p]) => p);
    const pull: Pull = { id: store.allocId(), number: repo.nextPull++, title: String(args.title), body: String(args.body ?? ''), state: 'open', head, base, headSha, baseSha, merged: false, merged_at: null, merge_commit_sha: null, created_at: store.now(), changed };
    repo.pulls.push(pull); return { result: asText({ id: pull.id, number: pull.number, title: pull.title, head: { ref: head }, base: { ref: base }, state: pull.state }) };
  }
  if (name === 'merge_pull_request') {
    const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
    if (!pull) return { result: { ...asText({ message: 'Pull request not found' }), isError: true } };
    const current = branchTip(repo, pull.base), head = branchTip(repo, pull.head), tree = store.headTree(repo, pull.head);
    if (!current || !head || !tree) return { result: { ...asText({ message: 'Pull request cannot be merged' }), isError: true } };
    const sha = store.commit(repo, tree, [current, head], `Merge pull request #${pull.number}`);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed'; pull.merged = true; pull.merged_at = store.now(); pull.merge_commit_sha = sha;
    return { result: asText({ number: pull.number, merged: true, state: 'closed', sha }) };
  }
  if (name === 'update_issue') {
    const issue = repo.issuesByNumber.get(Number(args.number));
    if (!issue) return { result: { ...asText({ message: 'Issue not found' }), isError: true } };
    if (args.state === 'closed' || args.state === 'open') issue.state = args.state;
    issue.updated_at = store.now(); return { result: asText({ number: issue.number, state: issue.state }) };
  }
  return { error: { code: -32602, message: 'Invalid tool parameters' } };
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined, store: ForgeStore, token: string): boolean {
  if ((req.url ?? '').split('?')[0] !== '/mcp') return false;
  const json = (status: number, value: unknown): void => { const text = `${JSON.stringify(value)}\n`; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) }); res.end(text); };
  if (req.headers.authorization !== `Bearer ${token}` || !token) { json(401, { message: 'Unauthorized' }); return true; }
  let input: Obj;
  try { const parsed: unknown = JSON.parse(body?.toString('utf8') ?? ''); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); input = parsed as Obj; }
  catch { json(400, rpcError(null, -32700, 'Parse error')); return true; }
  const method = String(input.method ?? ''), id = input.id;
  if (id === undefined) { res.writeHead(202, { 'content-length': '0' }); res.end(); return true; }
  const success = (result: unknown): Obj => ({ jsonrpc: '2.0', id, result });
  if (method === 'server/discover') {
    json(200, success({ resultType: 'serverInfo', supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } })); return true;
  }
  if (method === 'ping') { json(200, success({})); return true; }
  if (method === 'tools/list') { json(200, success({ tools })); return true; }
  if (method === 'tools/call') {
    const params = (input.params && typeof input.params === 'object' ? input.params : {}) as Obj;
    const called = callTool(String(params.name ?? ''), params.arguments, store);
    if (called.error) json(200, { jsonrpc: '2.0', id, error: called.error });
    else json(200, success(called.result));
    return true;
  }
  json(200, rpcError(id, -32601, `Method not found: ${method}`)); return true;
}
