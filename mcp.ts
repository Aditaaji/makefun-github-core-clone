// mcp.ts — Model Context Protocol over streamable HTTP (plain JSON answers).
// Speaks the modern 2026-07-28 era (server/discover) and the legacy handshake (initialize).
// Tools mirror github-mcp-server's names; results carry the object JSON as text content.

import { addComment, createIssue, createLabel, createPull, findLabel, getIssue, getPull, issueRelayId, mergePull, pullRelayId, repoRelayId } from './domain.ts';
import { prFiles, resolveCommit } from './store.ts';
import type { Store } from './store.ts';

export const MCP_SERVER_NAME = 'makefun-github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
        body: { type: 'string', description: 'Comment body' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
];

function repoJson(store: Store, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
  };
}

function issueJson(repo: Parameters<typeof createIssue>[0], issue: ReturnType<typeof createIssue>): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    user: { login: issue.userLogin },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Parameters<typeof createPull>[0], pr: NonNullable<ReturnType<typeof createPull>['pr']>): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    mergeable: true,
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

function textResult(obj: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}

function errorResult(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: McpToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

/** Execute one tools/call. Returns the tool result object (or an isError result). */
export function callTool(store: Store, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    // Unknown tools are answered by the JSON-RPC layer with -32602; this is unreachable for known names.
    return errorResult(`unknown tool: ${name}`);
  }
  const missing = missingArgs(tool, args);
  if (missing.length > 0) {
    return errorResult(`missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return errorResult(`repository ${VIEWER_LOGIN}/${repoName} already exists`);
      }
      const repo = store.createRepo(VIEWER_LOGIN, repoName, String(args.description ?? ''), args.private === true);
      return textResult(repoJson(store, VIEWER_LOGIN, repoName));
    }
    case 'get_repo': {
      const found = repoJson(store, String(args.owner), String(args.repo));
      if (found === null) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      return textResult(found);
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      const issue = createIssue(repo, String(args.title), String(args.body ?? ''), []);
      return textResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      const state = String(args.state ?? 'open');
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      return textResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      const { pr, error } = createPull(repo, String(args.title), String(args.body ?? ''), String(args.head), String(args.base));
      if (pr === null) return errorResult(error ?? 'could not create pull request');
      return textResult(pullJson(repo, pr));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      const pr = getPull(repo, Number(args.pull_number));
      if (pr === undefined) return errorResult(`pull request #${args.pull_number} not found`);
      const result = mergePull(repo, pr);
      if (result.status === 'conflict') return errorResult('merge conflict');
      return textResult(pullJson(repo, pr));
    }
    case 'get_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      const issue = getIssue(repo, Number(args.issue_number));
      if (issue === undefined) return errorResult(`issue #${args.issue_number} not found`);
      return textResult(issueJson(repo, issue));
    }
    case 'add_issue_comment': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === undefined) return errorResult(`repository ${args.owner}/${args.repo} not found`);
      const issue = getIssue(repo, Number(args.issue_number));
      if (issue === undefined) return errorResult(`issue #${args.issue_number} not found`);
      const comment = addComment(repo, issue, String(args.body));
      return textResult({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export function listTools(): McpToolDef[] {
  return TOOLS;
}

export function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

export function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'DiscoverResult',
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: serverInfo(),
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}
