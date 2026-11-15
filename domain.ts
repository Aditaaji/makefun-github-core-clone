// domain.ts — issue / label / pull-request operations shared by REST, GraphQL and MCP.

import { nextTimestamp, relayId, resolveCommit, squashMerge, VIEWER_LOGIN } from './store.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';

export function createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const ts = nextTimestamp();
  const issue: Issue = {
    id: repo.nextIssueId++,
    number: repo.nextIssue++,
    title,
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    userLogin: VIEWER_LOGIN,
    createdAt: ts.iso,
    updatedAt: ts.iso,
    seq: repo.seq++,
  };
  repo.issues.push(issue);
  return issue;
}

export function createLabel(repo: Repo, name: string, color: string, description = ''): Label {
  const label: Label = { id: repo.nextLabelId++, name, color: color || 'ededed', description };
  repo.labels.push(label);
  return label;
}

export function findLabel(repo: Repo, name: string): Label | undefined {
  return repo.labels.find((l) => l.name === name);
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((i) => i.number === number);
}

export function addComment(repo: Repo, issue: Issue, body: string): { id: number; body: string; createdAt: string; updatedAt: string } {
  const ts = nextTimestamp();
  const comment = { id: repo.nextCommentId++, body, userLogin: VIEWER_LOGIN, createdAt: ts.iso, updatedAt: ts.iso };
  issue.comments.push(comment);
  issue.updatedAt = ts.iso;
  return comment;
}

export function createPull(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): { pr: PullRequest | null; error: string | null } {
  const headSha = resolveCommit(repo, headRef);
  const baseSha = resolveCommit(repo, baseRef);
  if (headSha === null) return { pr: null, error: `head branch ${headRef} not found` };
  if (baseSha === null) return { pr: null, error: `base branch ${baseRef} not found` };
  const existing = repo.pulls.find((p) => p.headRef === headRef && p.baseRef === baseRef && p.state === 'open');
  if (existing !== undefined) return { pr: null, error: 'a pull request already exists for this head and base' };
  const ts = nextTimestamp();
  const pr: PullRequest = {
    id: repo.nextPullId++,
    number: repo.nextPull++,
    title,
    body: body ?? '',
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergeCommitSha: null,
    mergedAt: null,
    userLogin: VIEWER_LOGIN,
    createdAt: ts.iso,
    updatedAt: ts.iso,
    seq: repo.seq++,
  };
  repo.pulls.push(pr);
  return { pr, error: null };
}

export function getPull(repo: Repo, number: number): PullRequest | undefined {
  return repo.pulls.find((p) => p.number === number);
}

/** Squash-merge a pull request. Returns 'ok' | 'conflict' | 'not-found' | 'already'. */
export function mergePull(repo: Repo, pr: PullRequest): { status: 'ok' | 'conflict'; sha?: string } {
  if (pr.merged || pr.state === 'closed') return { status: 'ok', sha: pr.mergeCommitSha ?? undefined };
  const sha = squashMerge(repo, pr);
  if (sha === null) return { status: 'conflict' };
  const ts = nextTimestamp();
  pr.merged = true;
  pr.state = 'closed';
  pr.mergeCommitSha = sha;
  pr.mergedAt = ts.iso;
  pr.updatedAt = ts.iso;
  return { status: 'ok', sha };
}

export function issueRelayId(repo: Repo, issue: Issue): string {
  return relayId('Issue', repo.id, issue.number);
}

export function pullRelayId(repo: Repo, pr: PullRequest): string {
  return relayId('PullRequest', repo.id, pr.number);
}

export function repoRelayId(repo: Repo): string {
  return relayId('Repository', repo.id);
}
