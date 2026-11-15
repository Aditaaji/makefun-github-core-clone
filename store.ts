// store.ts — in-memory forge state: repos, git objects, issues, labels, pull requests.
// The viewer (token owner) is the scenario's fixed login: adaiversen (id 1000), derived from the
// kit's fixed SCENARIO_SEED (program/env/src/wire.ts buildScenario). The stranger is olgabauer.

import {
  ZERO_OID,
  countLines,
  diffTrees,
  encodeCommit,
  encodeTree,
  flattenTree,
  getCommit,
  isAncestor,
  isOid,
  mergeBase,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
} from './git.ts';
import type { CommitView, GitObject, TreeEntry } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';

/** Monotonic clock: every created entity gets a strictly increasing timestamp. */
let clockMs = Date.now();
export function nextTimestamp(): { iso: string; unix: number } {
  clockMs += 1;
  return { iso: new Date(clockMs).toISOString(), unix: Math.floor(clockMs / 1000) };
}

export function relayId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeRelayId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  /** Commit oids whose whole history is known present (memoizes push validation). */
  verifiedCommits: Set<string>;
  /** Monotonic git-state version: bumped on every objects/refs mutation; caches key off it. */
  gitVersion: number;
  /** Cached git-upload-pack fetch responses, keyed by protocol + request + gitVersion. */
  fetchCache: Map<string, Buffer>;
  /** Cached ls-refs response, valid only for the gitVersion it was built at. */
  lsRefsCache: { version: number; key: string; body: Buffer } | null;
  /** Cached v0 info/refs advertisement, valid only for the gitVersion it was built at. */
  infoRefsCache: { version: number; service: string; body: Buffer } | null;
  issues: Issue[];
  labels: Label[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  nextLabelId: number;
  nextIssueId: number;
  nextPullId: number;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextSeq = 0;

  seq(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const ts = nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: ts.iso,
      updatedAt: ts.iso,
      objects: new Map(),
      refs: new Map(),
      verifiedCommits: new Set(),
      gitVersion: 0,
      fetchCache: new Map(),
      lsRefsCache: null,
      infoRefsCache: null,
      issues: [],
      labels: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      nextIssueId: 1,
      nextPullId: 1,
      seq: this.seq(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  findRepoById(databaseId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === databaseId) return repo;
    return undefined;
  }
}

// -------------------------------------------------------------------------------------------
// git object construction on top of a repo
// -------------------------------------------------------------------------------------------

export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    bumpGit(repo);
  }
  return oid;
}

/**
 * Mark the repo's git state changed: bumps gitVersion and drops the cached git
 * smart-HTTP responses (fetch packs, ls-refs, info/refs). Callers mutate objects
 * or refs only through storeObject / the ref updates below, plus receive-pack.
 * Clearing is always safe (a cache miss just recomputes); a missed bump would
 * serve a stale pack, so every mutation site must call this.
 */
export function bumpGit(repo: Repo): void {
  repo.gitVersion += 1;
  repo.fetchCache.clear();
  repo.lsRefsCache = null;
  repo.infoRefsCache = null;
}

export function authorLine(): string {
  const ts = nextTimestamp();
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts.unix} +0000`;
}

/** Build a tree object for `entries` (flat path -> blob oid), creating intermediate trees. */
export function buildTree(repo: Repo, files: Map<string, string>): string {
  // files: path -> blob oid. Build bottom-up.
  interface Node {
    blobs: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { blobs: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { blobs: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.blobs.set(parts[parts.length - 1]!, oid);
  }
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.blobs) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: writeNode(child) });
    return storeObject(repo, 'tree', encodeTree(entries));
  };
  return writeNode(root);
}

/** The flat file map of a commit's tree (empty when the commit has no tree / repo unborn). */
export function treeFiles(repo: Repo, commitOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (commitOid === null) return out;
  const commit = getCommit(repo.objects, commitOid);
  if (commit === null) return out;
  for (const [path, entry] of flattenTree(repo.objects, commit.tree)) out.set(path, entry.oid);
  return out;
}

/** Commit `files` on `branch` (creating the branch / first commit as needed). Returns commit oid. */
export function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, string>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref) ?? null;
  const treeOid = buildTree(repo, files);
  const line = authorLine();
  const view: CommitView = { tree: treeOid, parents: parent === null ? [] : [parent], author: line, committer: line, message };
  const oid = storeObject(repo, 'commit', encodeCommit(view));
  repo.verifiedCommits.add(oid);
  repo.refs.set(ref, oid);
  bumpGit(repo);
  return oid;
}

/** Resolve a ref name (branch, full ref, or commit sha) to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) {
    const obj = repo.objects.get(tag);
    if (obj?.type === 'tag') return parseTag(obj.data).object;
    return tag;
  }
  return null;
}

/** The commit oid a ref resolves to, following annotated tags. */
export function resolveCommit(repo: Repo, ref: string | undefined): string | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  const obj = repo.objects.get(oid);
  if (obj?.type === 'tag') return parseTag(obj.data).object;
  if (obj?.type === 'commit') return oid;
  return null;
}

/** Peel a tag object to its commit (or return the oid unchanged). */
export function peelToCommit(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj?.type === 'tag') {
    const target = parseTag(obj.data).object;
    return peelToCommit(repo, target);
  }
  return oid;
}

// -------------------------------------------------------------------------------------------
// pull-request diff / merge
// -------------------------------------------------------------------------------------------

export interface PrFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function prFiles(repo: Repo, pr: PullRequest): PrFile[] {
  const head = getCommit(repo.objects, pr.headSha);
  const base = getCommit(repo.objects, pr.baseSha);
  const changes = diffTrees(repo.objects, base === null ? null : base.tree, head === null ? null : head.tree);
  return changes.map((c) => {
    const additions = countLines(repo.objects, c.newOid);
    const deletions = countLines(repo.objects, c.oldOid);
    const status = c.status === 'added' ? 'added' : c.status === 'removed' ? 'removed' : 'modified';
    return { filename: c.path, status, additions, deletions, changes: additions + deletions };
  });
}

/** File-level three-way merge. Returns the merged file map, or null on conflict. */
export function threeWayMerge(
  repo: Repo,
  baseTip: string,
  headTip: string,
): { files: Map<string, string>; conflict: boolean } {
  const mb = mergeBase(repo.objects, baseTip, headTip);
  const mbFiles = mb === null ? new Map<string, string>() : treeFiles(repo, mb);
  const baseFiles = treeFiles(repo, baseTip);
  const headFiles = treeFiles(repo, headTip);
  const merged = new Map<string, string>();
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const m = mbFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (h === m) {
      if (b !== undefined) merged.set(path, b);
    } else if (b === m) {
      if (h !== undefined) merged.set(path, h);
    } else if (b === h) {
      if (b !== undefined) merged.set(path, b);
    } else {
      return { files: merged, conflict: true };
    }
  }
  return { files: merged, conflict: false };
}

export function prMergeable(repo: Repo, pr: PullRequest): boolean {
  if (pr.merged) return false;
  const head = repo.objects.get(pr.headSha);
  const base = repo.objects.get(pr.baseSha);
  if (head === undefined || base === undefined) return false;
  return !threeWayMerge(repo, pr.baseSha, pr.headSha).conflict;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
export function squashMerge(repo: Repo, pr: PullRequest): string | null {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (baseTip === undefined) return null;
  const { files, conflict } = threeWayMerge(repo, baseTip, pr.headSha);
  if (conflict) return null;
  const treeOid = buildTree(repo, files);
  const line = authorLine();
  const view: CommitView = {
    tree: treeOid,
    parents: [baseTip],
    author: line,
    committer: line,
    message: `${pr.title} (#${pr.number})`,
  };
  const oid = storeObject(repo, 'commit', encodeCommit(view));
  repo.verifiedCommits.add(oid);
  repo.refs.set(`refs/heads/${pr.baseRef}`, oid);
  bumpGit(repo);
  return oid;
}

/** Is `tip` a fast-forward from `old` (old is an ancestor of tip, or old is zero)? Walks up from the
 * tip and stops as soon as `old` is found, so the common linear case costs one step. */
export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  const stack = [newOid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo.objects, oid);
    if (commit === null) continue;
    for (const p of commit.parents) stack.push(p);
  }
  return false;
}

/** Validate that a pushed commit's history is present, stopping at already-verified commits.
 * Newly verified commits are memoized on success only. */
export function historyPresentVerified(repo: Repo, oid: string): boolean {
  const stack = [oid];
  const seen = new Set<string>();
  const newly: string[] = [];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur) || repo.verifiedCommits.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined) return false;
    if (obj.type === 'commit') {
      newly.push(cur);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  for (const c of newly) repo.verifiedCommits.add(c);
  return true;
}

