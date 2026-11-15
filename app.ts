// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4, MCP.
// Stdlib only. One in-memory store per process; state is created through the APIs during a trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  encodeTree,
  flattenTree,
  getCommit,
  isOid,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  sideband,
  splitAtFlush,
  verifyPackChecksum,
  writePack,
} from './git.ts';
import type { GitObject } from './git.ts';
import {
  DEFAULT_BRANCH,
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildTree,
  commitFiles,
  historyPresent,
  isFastForward,
  nextTimestamp,
  peelToCommit,
  prFiles,
  prMergeable,
  resolveCommit,
  resolveRef,
  storeObject,
  threeWayMerge,
  treeFiles,
} from './store.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';
import {
  addComment,
  createIssue,
  createLabel,
  createPull,
  findLabel,
  getIssue,
  getPull,
  issueRelayId,
  mergePull,
  pullRelayId,
  repoRelayId,
} from './domain.ts';
import { executeGraphQL } from './graphql.ts';
import { callTool, discoverResult, listTools, serverInfo } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'makefun-github-core-clone/1.0.0';
const MAX_BODY = 64 * 1024 * 1024;

const store = new Store();

// -------------------------------------------------------------------------------------------
// http plumbing
// -------------------------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID(), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': randomUUID() });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': randomUUID() });
  res.end();
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

interface Route {
  method: string;
  path: string;
  query: URLSearchParams;
  segments: string[];
}

function routeOf(req: IncomingMessage): Route {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  const segments = url.pathname.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, segments };
}

function pagination(req: IncomingMessage, route: Route, total: number): { page: number; perPage: number; link: string | null } {
  const perPage = Math.min(100, Math.max(1, Number(route.query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(route.query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const base = `http://${req.headers.host ?? '127.0.0.1'}${route.path}`;
  const linkFor = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(linkFor(page + 1, 'next'));
  if (page > 1) parts.push(linkFor(page - 1, 'prev'));
  if (totalPages > 1) {
    parts.push(linkFor(1, 'first'));
    parts.push(linkFor(totalPages, 'last'));
  }
  return { page, perPage, link: parts.length > 0 ? parts.join(', ') : null };
}

function pageSlice<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// -------------------------------------------------------------------------------------------
// JSON shapes
// -------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User', site_admin: false };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoRelayId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const commit = getCommit(repo.objects, sha);
  if (commit === null) return null;
  const parsePerson = (line: string): { name: string; email: string; date: string } => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (m === null) return { name: line, email: '', date: repo.updatedAt };
    return { name: m[1]!, email: m[2]!, date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  const author = parsePerson(commit.author);
  const committer = parsePerson(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: commit.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, url: `/api/v3/labels/${label.id}` };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueRelayId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.userLogin),
    assignee: null,
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: pullRelayId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: userJson(repo.owner) },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: userJson(repo.owner) },
    merged: pr.merged,
    mergeable: pr.merged ? false : prMergeable(repo, pr),
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    merge_method: 'squash',
    user: userJson(pr.userLogin),
    assignee: null,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.state === 'closed' ? pr.updatedAt : null,
    draft: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Resolve a repo the viewer may see: any other owner is a 404, never a 403.
function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

// -------------------------------------------------------------------------------------------
// contents helpers
// -------------------------------------------------------------------------------------------

function contentFileJson(repo: Repo, path: string, blobOid: string, content: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: null,
    _links: { self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` },
  };
}

function dirEntries(repo: Repo, commitOid: string, dirPath: string): Record<string, unknown>[] | null {
  const commit = getCommit(repo.objects, commitOid);
  if (commit === null) return null;
  const flat = flattenTree(repo.objects, commit.tree);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const children = new Map<string, { kind: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const obj = repo.objects.get(entry.oid);
      children.set(rest, { kind: 'file', oid: entry.oid, size: obj?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        // Find the subtree oid for this directory.
        let treeOid = commit.tree;
        const parts = (dirPath === '' ? [] : dirPath.split('/')).concat([dir]);
        let found: string | null = null;
        for (const part of parts) {
          const tree = repo.objects.get(treeOid);
          if (tree === undefined || tree.type !== 'tree') {
            found = null;
            break;
          }
          const hit = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
          if (hit === undefined) {
            found = null;
            break;
          }
          found = hit.oid;
          treeOid = hit.oid;
        }
        children.set(dir, { kind: 'dir', oid: found ?? ZERO_OID, size: 0 });
      }
    }
  }
  if (children.size === 0) return null;
  const out: Record<string, unknown>[] = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const path = prefix + name;
    out.push({
      type: child.kind,
      name,
      path,
      sha: child.oid,
      size: child.size,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/tree/HEAD/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${child.oid}`,
      download_url: child.kind === 'file' ? `https://example.invalid/${repo.owner}/${repo.name}/raw/HEAD/${path}` : null,
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

function handleRest(req: IncomingMessage, res: ServerResponse, route: Route, body: Buffer): void {
  const seg = route.segments; // seg[0] === 'api', seg[1] === 'v3'
  const rest = seg.slice(2);

  // GET /api/v3/ — root.
  if (route.method === 'GET' && rest.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://example.invalid/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{/type}',
      user_search_url: '/api/v3/search/users?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (route.method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
    return;
  }

  // GET /api/v3/user
  if (route.method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
      avatar_url: 'https://example.invalid/avatar',
      type: 'User',
      site_admin: false,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      html_url: `https://example.invalid/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    });
    return;
  }

  // POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (route.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }] });
        return;
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
        parsed.value.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (route.method === 'GET') {
      const all = store.listViewerRepos();
      const { page, perPage, link } = pagination(req, route, all.length);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageSlice(all, page, perPage).map(repoJson), headers);
      return;
    }
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const repoName = rest[2]!;
    const repo = findRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://example.invalid/docs' });
      return;
    }
    const tail = rest.slice(3);
    handleRepoRest(req, res, route, body, repo, tail);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleRepoRest(req: IncomingMessage, res: ServerResponse, route: Route, body: Buffer, repo: Repo, tail: string[]): void {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;

  // Repo itself: GET / PATCH / DELETE
  if (tail.length === 0) {
    if (route.method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (route.method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      if (typeof parsed.value.default_branch === 'string' && repo.refs.has(`refs/heads/${parsed.value.default_branch}`)) {
        repo.defaultBranch = parsed.value.default_branch;
      }
      repo.updatedAt = nextTimestamp().iso;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (route.method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, 204);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const head = tail[0]!;

  // Branches
  if (head === 'branches') {
    if (tail.length === 1 && route.method === 'GET') {
      const list: Record<string, unknown>[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (ref.startsWith('refs/heads/')) list.push(branchJson(repo, ref.slice('refs/heads/'.length), sha));
      }
      sendJson(res, 200, list);
      return;
    }
    if (tail.length >= 2 && route.method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Branch not found' });
        return;
      }
      sendJson(res, 200, branchJson(repo, branch, sha));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Commits
  if (head === 'commits' && route.method === 'GET') {
    if (tail.length === 2) {
      const sha = resolveCommit(repo, tail[1]);
      if (sha === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const one = commitJson(repo, sha);
      if (one === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, one);
      return;
    }
    const tip = resolveCommit(repo, route.query.get('sha') ?? undefined);
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const list: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const commit = getCommit(repo.objects, oid);
      if (commit === null) continue;
      seen.add(oid);
      const one = commitJson(repo, oid);
      if (one !== null) list.push(one);
      for (const p of commit.parents) stack.push(p);
    }
    if (route.query.has('per_page') || route.query.has('page')) {
      const { page, perPage, link } = pagination(req, route, list.length);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageSlice(list, page, perPage), headers);
      return;
    }
    sendJson(res, 200, list);
    return;
  }

  // Git refs
  if (head === 'git' && tail[1] === 'refs') {
    if (route.method === 'POST' && tail.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'invalid' }] });
        return;
      }
      const obj = repo.objects.get(sha);
      if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'sha', code: 'invalid' }] });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: obj.type, url: `${base}/git/${obj.type}s/${sha}` }, url: `${base}/git/refs/${ref}` });
      return;
    }
    if (route.method === 'GET') {
      if (tail.length === 2) {
        const list: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          const obj = repo.objects.get(sha);
          list.push({ ref, object: { sha, type: obj?.type ?? 'commit', url: `${base}/git/commits/${sha}` }, url: `${base}/git/refs/${ref}` });
        }
        sendJson(res, 200, list);
        return;
      }
      const ref = tail.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const obj = repo.objects.get(sha);
      sendJson(res, 200, { ref, object: { sha, type: obj?.type ?? 'commit', url: `${base}/git/commits/${sha}` }, url: `${base}/git/refs/${ref}` });
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Contents
  if (head === 'contents') {
    const filePath = tail.slice(1).join('/');
    handleContents(req, res, route, body, repo, filePath);
    return;
  }

  // Labels
  if (head === 'labels') {
    if (route.method === 'GET' && tail.length === 1) {
      sendJson(res, 200, repo.labels.map(labelJson));
      return;
    }
    if (route.method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing' }] });
        return;
      }
      if (findLabel(repo, name) !== undefined) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        return;
      }
      const label = createLabel(repo, name, typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed', typeof parsed.value.description === 'string' ? parsed.value.description : '');
      sendJson(res, 201, labelJson(label));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Issues
  if (head === 'issues') {
    handleIssues(req, res, route, body, repo, tail.slice(1));
    return;
  }

  // Pulls
  if (head === 'pulls') {
    handlePulls(req, res, route, body, repo, tail.slice(1));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleContents(req: IncomingMessage, res: ServerResponse, route: Route, body: Buffer, repo: Repo, filePath: string): void {
  const refParam = route.query.get('ref') ?? undefined;
  if (route.method === 'GET') {
    const commitOid = resolveCommit(repo, refParam);
    if (commitOid === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const files = treeFiles(repo, commitOid);
    const blobOid = files.get(filePath);
    if (blobOid !== undefined) {
      const obj = repo.objects.get(blobOid);
      if (obj === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      sendJson(res, 200, contentFileJson(repo, filePath, blobOid, obj.data));
      return;
    }
    const entries = dirEntries(repo, commitOid, filePath);
    if (entries === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendJson(res, 200, entries);
    return;
  }

  if (route.method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendJson(res, 400, { message: 'Invalid JSON body' });
      return;
    }
    const contentB64 = typeof parsed.value.content === 'string' ? parsed.value.content : '';
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendJson(res, 422, { message: 'content is not valid base64' });
      return;
    }
    const tip = resolveCommit(repo, branch);
    const files = treeFiles(repo, tip);
    const existing = files.get(filePath);
    if (existing !== undefined) {
      if (givenSha === undefined) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Content', field: 'sha', code: 'missing' }] });
        return;
      }
      if (givenSha.toLowerCase() !== existing.toLowerCase()) {
        sendJson(res, 409, { message: 'sha does not match the current file' });
        return;
      }
    }
    const blobOid = storeObject(repo, 'blob', content);
    files.set(filePath, blobOid);
    const commitOid = commitFiles(repo, branch, files, `${message}\n`);
    const ts = nextTimestamp();
    sendJson(res, existing === undefined ? 201 : 200, {
      content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}` },
      commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: ts.iso }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: ts.iso }, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}` },
    });
    return;
  }

  if (route.method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendJson(res, 400, { message: 'Invalid JSON body' });
      return;
    }
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch;
    const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
    const tip = resolveCommit(repo, branch);
    const files = treeFiles(repo, tip);
    const existing = files.get(filePath);
    if (existing === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (givenSha !== undefined && givenSha.toLowerCase() !== existing.toLowerCase()) {
      sendJson(res, 409, { message: 'sha does not match the current file' });
      return;
    }
    files.delete(filePath);
    const commitOid = commitFiles(repo, branch, files, `${message}\n`);
    const ts = nextTimestamp();
    sendJson(res, 200, {
      commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: ts.iso }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: ts.iso }, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitOid}` },
      content: null,
    });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handleIssues(req: IncomingMessage, res: ServerResponse, route: Route, body: Buffer, repo: Repo, tail: string[]): void {
  // GET/POST /issues
  if (tail.length === 0) {
    if (route.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      if (title === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing' }] });
        return;
      }
      const labelNames = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
      const labels: Label[] = [];
      for (const name of labelNames) {
        const label = findLabel(repo, name);
        if (label === undefined) {
          sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist`, errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
          return;
        }
        labels.push(label);
      }
      const issue = createIssue(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', labels);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (route.method === 'GET') {
      const state = route.query.get('state') ?? 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      const direction = route.query.get('direction') ?? 'desc';
      const sort = route.query.get('sort') ?? 'created';
      if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, perPage, link } = pagination(req, route, list.length);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageSlice(list, page, perPage).map((i) => issueJson(repo, i)), headers);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const issue = getIssue(repo, number);
  if (issue === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (route.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const commentBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      if (commentBody === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing' }] });
        return;
      }
      const comment = addComment(repo, issue, commentBody);
      sendJson(res, 201, commentJson(repo, issue, comment));
      return;
    }
    if (route.method === 'GET') {
      const { page, perPage, link } = pagination(req, route, issue.comments.length);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageSlice(issue.comments, page, perPage).map((c) => commentJson(repo, issue, c)), headers);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (tail.length === 1) {
    if (route.method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (route.method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      if (Array.isArray(parsed.value.labels)) {
        const labels: Label[] = [];
        for (const name of parsed.value.labels as unknown[]) {
          if (typeof name !== 'string') continue;
          const label = findLabel(repo, name);
          if (label === undefined) {
            sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
            return;
          }
          labels.push(label);
        }
        issue.labels = labels;
      }
      issue.updatedAt = nextTimestamp().iso;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

function handlePulls(req: IncomingMessage, res: ServerResponse, route: Route, body: Buffer, repo: Repo, tail: string[]): void {
  // GET/POST /pulls
  if (tail.length === 0) {
    if (route.method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
      const base = typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch;
      if (title === '' || head === '') {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'title', code: 'missing' }] });
        return;
      }
      const { pr, error } = createPull(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', head, base);
      if (pr === null) {
        sendJson(res, 422, { message: error ?? 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head' }] });
        return;
      }
      sendJson(res, 201, pullJson(repo, pr));
      return;
    }
    if (route.method === 'GET') {
      const state = route.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.seq - a.seq);
      const { page, perPage, link } = pagination(req, route, list.length);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageSlice(list, page, perPage).map((p) => pullJson(repo, p)), headers);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const pr = getPull(repo, number);
  if (pr === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files' && route.method === 'GET') {
    const files = prFiles(repo, pr).map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    }));
    sendJson(res, 200, files);
    return;
  }

  // /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && route.method === 'PUT') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendJson(res, 400, { message: 'Invalid JSON body' });
      return;
    }
    const method = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    if (!['squash', 'merge', 'rebase'].includes(method)) {
      sendJson(res, 422, { message: `merge_method must be one of squash, merge, rebase` });
      return;
    }
    if (pr.merged) {
      sendJson(res, 200, { sha: pr.mergeCommitSha, merged: true, message: `Pull request #${pr.number} already merged` });
      return;
    }
    const result = mergePull(repo, pr);
    if (result.status === 'conflict') {
      sendJson(res, 405, { message: 'Merge conflict: the head and base both changed the same files' });
      return;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: `Merge pull request #${pr.number} from ${pr.headRef}` });
    return;
  }

  if (tail.length === 1 && route.method === 'GET') {
    sendJson(res, 200, pullJson(repo, pr));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT}`
      : `report-status-v2 report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  const refs = sortedRefs(repo);
  const body = Buffer.concat([
    pktLine(`${headOid} HEAD\0${caps}\n`),
    ...(refs.length === 0 ? [pktLine(`${ZERO_OID} capabilities^{}\n`)] : []),
    ...refs.flatMap(({ name, oid }) => {
      const out = [pktLine(`${oid} ${name}\n`)];
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        const peeled = peelToCommit(repo, target);
        out.push(pktLine(`${peeled} ${name}^{}\n`));
      }
      return out;
    }),
    PKT_FLUSH,
  ]);
  parts.push(body);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  const objects = new Map<string, GitObject>();
  const haveClosure = new Set<string>();
  for (const h of haves) {
    for (const c of commitClosure(repo, h)) haveClosure.add(c);
    haveClosure.add(h);
  }
  const shallowSet = new Set(shallowBoundaries);
  const included = new Set<string>(); // commit oids whose objects we send
  const boundary = new Set<string>(); // included commits at the edge (shallow)
  const wantTags = new Set<string>();

  const addCommitAndTree = (oid: string): void => {
    const commit = getCommit(repo.objects, oid);
    if (commit === null) return;
    if (!objects.has(oid)) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.set(oid, obj);
    }
    const treeObj = repo.objects.get(commit.tree);
    if (treeObj !== undefined) objects.set(commit.tree, treeObj);
    // Include every tree object on the path, not just the root: walk the tree.
    const walkTree = (treeOid: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const child = repo.objects.get(entry.oid);
        if (child === undefined) continue;
        objects.set(entry.oid, child);
        if (entry.mode === '40000') walkTree(entry.oid);
      }
    };
    walkTree(commit.tree);
  };

  if (depth !== null) {
    // BFS from wants, depth edges (depth 1 = wants only).
    const queue: Array<{ oid: string; level: number }> = wants.map((w) => ({ oid: w, level: 1 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, level } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = getCommit(repo.objects, oid);
      if (commit === null) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') wantTags.add(oid);
        continue;
      }
      included.add(oid);
      if (level >= depth || commit.parents.length === 0) {
        boundary.add(oid);
      } else {
        for (const p of commit.parents) {
          if (!seen.has(p) && !haveClosure.has(p)) queue.push({ oid: p, level: level + 1 });
        }
        if (commit.parents.length === 0) boundary.add(oid);
      }
    }
    // Objects: included commits except those the client already holds (haves + shallow tips).
    for (const oid of included) {
      if (haveClosure.has(oid)) continue;
      if (shallowSet.has(oid)) continue;
      addCommitAndTree(oid);
    }
  } else {
    // Full closure of wants, minus the haves' closure, stopping at shallow boundaries.
    const stack = [...wants];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = getCommit(repo.objects, oid);
      if (commit === null) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tag') wantTags.add(oid);
        continue;
      }
      if (haveClosure.has(oid)) continue;
      included.add(oid);
      if (shallowSet.has(oid)) continue; // stays shallow: do not walk its parents
      for (const p of commit.parents) stack.push(p);
    }
    for (const oid of included) addCommitAndTree(oid);
  }

  // Wanted tags: include the tag object and its target's history.
  for (const tagOid of wantTags) {
    const tag = repo.objects.get(tagOid);
    if (tag !== undefined) objects.set(tagOid, tag);
    if (tag?.type === 'tag') {
      const target = parseTag(tag.data).object;
      const targetCommit = getCommit(repo.objects, target);
      if (targetCommit !== null && !included.has(target)) {
        if (depth === null) {
          const stack = [target];
          const seen = new Set<string>();
          while (stack.length > 0) {
            const oid = stack.pop()!;
            if (seen.has(oid) || haveClosure.has(oid)) continue;
            seen.add(oid);
            const c = getCommit(repo.objects, oid);
            if (c === null) continue;
            addCommitAndTree(oid);
            for (const p of c.parents) stack.push(p);
          }
        } else {
          addCommitAndTree(target);
        }
      }
    }
  }

  // Shallow / unshallow lines.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) {
      if (!haveClosure.has(oid) && !shallowSet.has(oid)) shallow.push(oid);
      else if (shallowSet.has(oid)) shallow.push(oid);
    }
    // An old boundary is unshallow when its parents were sent in this fetch.
    for (const old of shallowBoundaries) {
      const commit = getCommit(repo.objects, old);
      if (commit === null) continue;
      const parentsSent = commit.parents.length > 0 && commit.parents.every((p) => included.has(p) && !haveClosure.has(p));
      if (parentsSent) unshallow.push(old);
    }
  } else {
    for (const oid of shallowBoundaries) shallow.push(oid);
  }

  // ACKs: haves that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const h of haves) {
    if (wants.some((w) => w === h || isAncestorOf(repo, h, w))) acks.push(h);
  }
  return { objects, shallow, unshallow, acks, nak: haves.length === 0 || acks.length === 0 };
}

function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const stack = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo.objects, oid);
    if (commit === null) continue;
    if (commit.parents.includes(ancestor)) return true;
    for (const p of commit.parents) stack.push(p);
  }
  return false;
}

function commitClosure(repo: Repo, tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const commit = getCommit(repo.objects, oid);
    if (commit === null) continue;
    out.add(oid);
    for (const p of commit.parents) stack.push(p);
  }
  return out;
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'unknown service' });
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    return;
  }
  sendBuffer(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
}

function parseV2Args(lines: Array<{ kind: string; payload?: Buffer }>): Record<string, string[]> {
  const args: Record<string, string[]> = {};
  for (const line of lines) {
    if (line.kind !== 'data' || line.payload === undefined) continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    const space = text.indexOf(' ');
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? '' : text.slice(space + 1);
    if (!args[key]) args[key] = [];
    args[key]!.push(value);
  }
  return args;
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const first = packets.find((p) => p.kind === 'data');
  const firstText = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8') : '';

  // Protocol v2: first line is "command=...".
  if (firstText.startsWith('command=')) {
    const command = firstText.slice('command='.length).replace(/\n$/, '');
    // Split at delim: header lines, then argument lines, then flush.
    let delimIndex = packets.findIndex((p) => p.kind === 'delim');
    if (delimIndex < 0) delimIndex = packets.length;
    const argPackets = packets.slice(delimIndex + 1).filter((p) => p.kind === 'data');
    const args = parseV2Args(argPackets);

    if (command === 'ls-refs') {
      const prefixes = args['ref-prefix'] ?? [];
      const peel = args.peel !== undefined;
      const symrefs = args.symrefs !== undefined;
      const unborn = args.unborn !== undefined;
      const out: string[] = [];
      const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      const matchPrefix = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      if (headOid === undefined) {
        if (unborn && matchPrefix('HEAD')) out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
      } else if (matchPrefix('HEAD')) {
        out.push(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
      }
      for (const { name, oid } of sortedRefs(repo)) {
        if (!matchPrefix(name)) continue;
        let line = `${oid} ${name}`;
        const obj = repo.objects.get(oid);
        if (peel && obj?.type === 'tag') {
          const target = parseTag(obj.data).object;
          line += ` peeled:${peelToCommit(repo, target)}`;
        }
        out.push(`${line}\n`);
      }
      sendBuffer(res, 200, Buffer.concat([encodePktLines(out), PKT_FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }

    if (command === 'fetch') {
      const wants = args.want ?? [];
      const haves = args.have ?? [];
      const shallowIn = args.shallow ?? [];
      let depth: number | null = null;
      if (args.deepen !== undefined && args.deepen.length > 0) {
        const n = Number(args.deepen[0]);
        if (Number.isFinite(n) && n >= 0) depth = Math.trunc(n);
      }
      const plan = computeFetch(repo, wants, haves, shallowIn, depth);
      const pack = writePack(plan.objects);
      const parts: Buffer[] = [];
      parts.push(pktLine('acknowledgments\n'));
      if (plan.nak) parts.push(pktLine('NAK\n'));
      else {
        for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
        parts.push(pktLine('ready\n'));
      }
      parts.push(PKT_DELIM);
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(sideband(pack, 1));
      parts.push(PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }

    sendJson(res, 400, { message: `unknown v2 command ${command}` });
    return;
  }

  // Protocol v0: want lines, flush, have lines, done, flush.
  try {
    const { lines, rest } = splitAtFlush(body);
    const wants: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    for (const line of lines) {
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      const [firstWord, ...restWords] = text.split(' ');
      if (firstWord === 'want') {
        const oid = restWords[0] ?? '';
        if (isOid(oid)) wants.push(oid);
      } else if (firstWord === 'shallow') {
        if (isOid(restWords[0] ?? '')) shallowIn.push(restWords[0]!);
      } else if (firstWord === 'deepen') {
        const n = Number(restWords[0]);
        if (Number.isFinite(n) && n >= 0) depth = Math.trunc(n);
      }
    }
    const second = decodePktLines(rest);
    const haves: string[] = [];
    for (const line of second) {
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      if (text.startsWith('have ')) {
        const oid = text.slice(5).trim();
        if (isOid(oid)) haves.push(oid);
      }
    }
    const plan = computeFetch(repo, wants, haves, shallowIn, depth);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [];
    if (plan.nak) parts.push(pktLine('NAK\n'));
    else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(sideband(pack, 1));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
  }
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let sidebandOn = false;
  let packBytes: Buffer = Buffer.alloc(0);
  try {
    const { lines, rest } = splitAtFlush(body);
    packBytes = rest;
    for (const line of lines) {
      if (line.kind !== 'data') continue;
      let text = line.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sidebandOn = true;
        text = text.slice(0, nul);
      }
      const parts = text.split(' ');
      if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
    }
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }

  const report: string[] = [];
  if (commands.length === 0) {
    report.push('unpack ok\n');
    const out = encodePktLines(report);
    sendBuffer(res, 200, sidebandOn ? Buffer.concat([sideband(out, 1), PKT_FLUSH]) : Buffer.concat([out, PKT_FLUSH]), 'application/x-git-receive-pack-result');
    return;
  }

  // Unpack the pack (if any).
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack trailer checksum mismatch');
      const { objects } = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (commands.some((c) => c.newOid !== ZERO_OID)) {
    unpackError = 'missing pack for update commands';
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
  } else {
    report.push('unpack ok\n');
    for (const c of commands) {
      const current = repo.refs.get(c.ref) ?? ZERO_OID;
      if (c.oldOid !== current) {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (c.newOid === ZERO_OID) {
        repo.refs.delete(c.ref);
        results.push({ ref: c.ref, ok: true, reason: '' });
        continue;
      }
      const obj = repo.objects.get(c.newOid);
      if (obj === undefined || (obj.type !== 'commit' && obj.type !== 'tag')) {
        results.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
        continue;
      }
      if (!historyPresent(repo, c.newOid)) {
        results.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
        continue;
      }
      if (c.oldOid !== ZERO_OID && !isFastForward(repo, c.oldOid, c.newOid)) {
        results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      results.push({ ref: c.ref, ok: true, reason: '' });
    }
  }
  for (const r of results) {
    report.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const out = encodePktLines(report);
  sendBuffer(res, 200, sidebandOn ? Buffer.concat([sideband(out, 1), PKT_FLUSH]) : Buffer.concat([out, PKT_FLUSH]), 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// GraphQL + MCP
// -------------------------------------------------------------------------------------------

function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Invalid JSON body' });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'request must carry a query string' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    const result = executeGraphQL(doc.query, variables, { store }, typeof doc.operationName === 'string' ? doc.operationName : null);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (req.method === 'DELETE') {
    sendEmpty(res, 204);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  let doc: unknown;
  try {
    doc = body.length === 0 ? null : JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(doc) || doc.jsonrpc !== '2.0' || typeof doc.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(doc) ? (doc.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = doc.id ?? null;
  const params = isRecord(doc.params) ? doc.params : {};
  const ok = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const fail = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  // Notifications carry no id: answer 202 with no body.
  if (id === null && doc.method.startsWith('notifications/')) {
    sendEmpty(res, 202);
    return;
  }

  switch (doc.method) {
    case 'server/discover': {
      ok(discoverResult());
      return;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      const negotiated = requested === '2026-07-28' || requested === '2025-11-25' ? requested : '2025-11-25';
      ok({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: serverInfo() });
      return;
    }
    case 'ping': {
      ok({});
      return;
    }
    case 'tools/list': {
      ok({ tools: listTools() });
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const known = listTools().some((t) => t.name === name);
      if (!known) {
        fail(-32602, `unknown tool: ${name}`);
        return;
      }
      ok(callTool(store, name, args));
      return;
    }
    default: {
      fail(-32601, `Method not found: ${doc.method}`);
      return;
    }
  }
}

// -------------------------------------------------------------------------------------------
// server
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const route = routeOf(req);
        // The boot probe takes no token.
        if (route.method === 'GET' && route.path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://example.invalid/docs' });
          return;
        }
        const body = await readBody(req);
        const seg = route.segments;
        if (seg.length >= 1 && seg[0] === 'api' && seg[1] === 'graphql' && seg.length === 2) {
          if (route.method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          handleGraphQL(req, res, body);
          return;
        }
        if (seg.length === 1 && seg[0] === 'mcp') {
          handleMcp(req, res, body);
          return;
        }
        if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
          handleRest(req, res, route, body);
          return;
        }
        // git smart HTTP: /{owner}/{repo}.git/...
        if (seg.length >= 2 && seg[1]!.endsWith('.git')) {
          const owner = seg[0]!;
          const repoName = seg[1]!.slice(0, -4);
          const repo = findRepo(owner, repoName);
          if (repo === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const tail = seg.slice(2);
          if (route.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = route.query.get('service') ?? '';
            handleInfoRefs(req, res, repo, service);
            return;
          }
          if (route.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
            handleUploadPack(req, res, repo, body);
            return;
          }
          if (route.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
            handleReceivePack(req, res, repo, body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // response already gone
        }
      }
    })();
  });
}
