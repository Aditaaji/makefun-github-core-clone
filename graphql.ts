// graphql.ts — a small GraphQL executor for exactly the documents gh / github-mcp-server send
// (see kit program/env/src/checks-graphql.ts). No dependencies: hand-written lexer, parser and
// resolvers over the in-memory store. Unknown fields produce a 200 + errors array naming the field.

import { relayId } from './store.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  decodeRelayId as decodeId,
  resolveCommit,
} from './store.ts';
import { addComment, createIssue, createPull, getIssue, getPull, issueRelayId, mergePull, pullRelayId, repoRelayId } from './domain.ts';
import { prFiles } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc ?? '';
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      if (src[j] === '.') {
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      tokens.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser (AST)
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
  selections: SelectionNode[];
  typeCondition: string | null;
}

export type SelectionNode = FieldNode | FragmentNode | SpreadNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string }>;
  selections: SelectionNode[];
}

export interface FragmentDef {
  kind: 'fragmentDef';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export interface Document {
  operations: OperationNode[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}, got ${JSON.stringify(t)}`);
  }

  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name' && t.kind !== 'int') throw new Error(`expected name, got ${JSON.stringify(t)}`);
    if (v !== undefined && t.value !== v) throw new Error(`expected ${v}, got ${t.value}`);
    return t.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArgs();
    }
  }

  parseDocument(): Document {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragmentDef', name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const variableDefinitions: Array<{ name: string; type: string }> = [];
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation, name, variableDefinitions, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = t.value as 'query' | 'mutation';
      this.next();
    } else {
      throw new Error(`expected operation, got ${JSON.stringify(t)}`);
    }
    if (this.peek().kind === 'name') name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
        variableDefinitions.push({ name: varName, type });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selections };
  }

  private parseType(): string {
    let type = '';
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name, selections: [], typeCondition: null };
      }
      throw new Error('bad fragment spread');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArgs();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema tables (for __type introspection)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'mergeCommit', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'defaultBranch', 'forkCount', 'stargazerCount'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MARKETPLACE', 'TOPIC', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

export interface GqlContext {
  store: Store;
}

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

type Resolver = (source: GqlObject, args: Record<string, unknown>, ctx: GqlContext) => unknown;

function userObject(login: string): GqlObject {
  return { __typename: 'User', login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, name: login === VIEWER_LOGIN ? VIEWER_NAME : login, email: login === VIEWER_LOGIN ? VIEWER_EMAIL : `${login}@example.invalid` };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: issueRelayId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function prObject(repo: Repo, pr: PullRequest): GqlObject {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pr: pr,
    id: pullRelayId(repo, pr),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergeable: pr.merged ? 'UNKNOWN' : 'MERGEABLE',
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

function repoObject(repo: Repo): GqlObject {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return {
    __typename: 'Repository',
    _repo: repo,
    id: repoRelayId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObject(repo.owner),
    defaultBranchRef: tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : 30;
  const afterSeq = seqOfCursor(args.after as string | null | undefined);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? undefined;
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const desc = orderBy?.direction === 'DESC';
  list.sort((a, b) => (desc ? b.seq - a.seq : a.seq - b.seq));
  if (afterSeq !== null) {
    list = list.filter((i) => (desc ? i.seq < afterSeq : i.seq > afterSeq));
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.seq) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueObject(repo, i)),
    totalCount: list.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, endCursor, startCursor: page.length > 0 ? cursorFor(page[0]!.seq) : null },
  };
}

function prConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : 30;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let list = [...repo.pulls];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((p) => wanted.has(p.state) || (p.merged && wanted.has('merged')));
  } else {
    list = list.filter((p) => p.state === 'open');
  }
  list.sort((a, b) => b.seq - a.seq);
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((p) => prObject(repo, p)),
    totalCount: list.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: list.length > page.length, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObject(VIEWER_LOGIN),
    repository: (_s, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObject(repo);
    },
    node: (_s, args, ctx) => {
      const decoded = decodeId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
        return repo === undefined ? null : repoObject(repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
        const issue = repo === undefined ? undefined : getIssue(repo, Number(decoded.parts[1]));
        return repo === undefined || issue === undefined ? null : issueObject(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
        const pr = repo === undefined ? undefined : getPull(repo, Number(decoded.parts[1]));
        return repo === undefined || pr === undefined ? null : prObject(repo, pr);
      }
      return null;
    },
    __type: (_s, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) {
        return {
          __typename: '__Type',
          name,
          kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT',
          fields: (TYPE_FIELDS[name] ?? []).map((f) => ({ __typename: '__Field', name: f })),
          enumValues: (ENUM_VALUES[name] ?? []).map((v) => ({ __typename: '__EnumValue', name: v })),
        };
      }
      return null;
    },
  },
  Repository: {
    issue: (s, args) => {
      const repo = s._repo as Repo;
      const issue = getIssue(repo, Number(args.number));
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (s, args) => issueConnection(s._repo as Repo, args),
    pullRequest: (s, args) => {
      const repo = s._repo as Repo;
      const pr = getPull(repo, Number(args.number));
      return pr === undefined ? null : prObject(repo, pr);
    },
    pullRequests: (s, args) => prConnection(s._repo as Repo, args),
  },
  Issue: {
    author: (s) => userObject((s._issue as Issue).userLogin),
    repository: (s) => repoObject(s._repo as Repo),
  },
  PullRequest: {
    author: (s) => userObject((s._pr as PullRequest).userLogin),
    repository: (s) => repoObject(s._repo as Repo),
    headRef: (s) => ({ __typename: 'Ref', name: (s._pr as PullRequest).headRef }),
    baseRef: (s) => ({ __typename: 'Ref', name: (s._pr as PullRequest).baseRef }),
    mergeable: (s) => {
      const pr = s._pr as PullRequest;
      if (pr.merged) return 'UNKNOWN';
      const repo = s._repo as Repo;
      if (resolveCommit(repo, pr.headRef) === null || resolveCommit(repo, pr.baseRef) === null) return 'UNKNOWN';
      return 'MERGEABLE';
    },
    files: (s, args) => {
      const repo = s._repo as Repo;
      const pr = s._pr as PullRequest;
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = prFiles(repo, pr).slice(0, first);
      return {
        __typename: 'FileConnection',
        nodes: files.map((f) => ({ __typename: 'File', path: f.filename })),
        totalCount: files.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
      };
    },
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createIssue: unknown repositoryId');
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new Error('createIssue: unknown repositoryId');
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue) };
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('closeIssue: unknown issueId');
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      const issue = repo === undefined ? undefined : getIssue(repo, Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) throw new Error('closeIssue: unknown issueId');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new Error('createPullRequest: unknown repositoryId');
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      if (repo === undefined) throw new Error('createPullRequest: unknown repositoryId');
      const { pr, error } = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if (pr === null) throw new Error(`createPullRequest: ${error ?? 'failed'}`);
      return { __typename: 'CreatePullRequestPayload', pullRequest: prObject(repo, pr) };
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('mergePullRequest: unknown pullRequestId');
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      const pr = repo === undefined ? undefined : getPull(repo, Number(decoded.parts[1]));
      if (repo === undefined || pr === undefined) throw new Error('mergePullRequest: unknown pullRequestId');
      const result = mergePull(repo, pr);
      if (result.status === 'conflict') throw new Error('mergePullRequest: merge conflict');
      return { __typename: 'MergePullRequestPayload', pullRequest: prObject(repo, pr) };
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('addComment: unknown subjectId');
      const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
      const issue = repo === undefined ? undefined : getIssue(repo, Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) throw new Error('addComment: unknown subjectId');
      const comment = addComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'IssueComment', id: relayId('IssueComment', repo.id, issue.number, comment.id), body: comment.body },
        },
      };
    },
  },
};

const KNOWN_ROOT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

function fieldsOf(typeName: string): string[] {
  if (TYPE_FIELDS[typeName] !== undefined) return TYPE_FIELDS[typeName]!;
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'FileConnection') return ['nodes', 'totalCount', 'pageInfo'];
  if (typeName === 'PageInfo') return ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'];
  if (typeName === 'Ref') return ['name', 'target'];
  if (typeName === 'Commit') return ['oid', 'message'];
  if (typeName === 'File') return ['path'];
  if (typeName === 'IssueComment') return ['id', 'body', 'author'];
  if (typeName === 'CommentEdge') return ['node', 'cursor'];
  if (typeName === '__Type') return ['name', 'kind', 'fields', 'enumValues', 'description'];
  if (typeName === '__Field') return ['name', 'description', 'type'];
  if (typeName === '__EnumValue') return ['name', 'description'];
  if (typeName === 'CreateIssuePayload') return ['issue', 'clientMutationId'];
  if (typeName === 'CloseIssuePayload') return ['issue', 'clientMutationId'];
  if (typeName === 'CreatePullRequestPayload') return ['pullRequest', 'clientMutationId'];
  if (typeName === 'MergePullRequestPayload') return ['pullRequest', 'clientMutationId'];
  if (typeName === 'AddCommentPayload') return ['commentEdge', 'subject', 'clientMutationId'];
  return [];
}

function resolveField(typeName: string, source: GqlObject, field: FieldNode, args: Record<string, unknown>, ctx: GqlContext): unknown {
  const table = RESOLVERS[typeName];
  const resolver = table?.[field.name];
  if (resolver !== undefined) return resolver(source, args, ctx);
  const value = source[field.name];
  if (value !== undefined) return value;
  if (field.name === '__typename') return typeName;
  return undefined;
}

function executeSelections(
  typeName: string,
  source: GqlObject | null,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  doc: Document,
  ctx: GqlContext,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === null) return out;
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, source, sel.selections, variables, doc, ctx, errors));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const def = doc.fragments.get(sel.name);
      if (def !== undefined && (def.typeCondition === typeName || def.typeCondition === 'Node')) {
        Object.assign(out, executeSelections(typeName, source, def.selections, variables, doc, ctx, errors));
      }
      continue;
    }
    const field = sel;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const known = typeName === 'Query' || typeName === 'Mutation' ? KNOWN_ROOT_FIELDS[typeName]!.includes(field.name) : fieldsOf(typeName).includes(field.name);
    if (!known) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of field.args) args[a.name] = valueOf(a.value, variables);
    let value: unknown;
    try {
      value = resolveField(typeName, source, field, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, field, variables, doc, ctx, errors);
  }
  return out;
}

function completeValue(
  value: unknown,
  field: FieldNode,
  variables: Record<string, unknown>,
  doc: Document,
  ctx: GqlContext,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (field.selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        const obj = item as GqlObject;
        return executeSelections(obj.__typename, obj, field.selections, variables, doc, ctx, errors);
      }
      return item;
    });
  }
  if (typeof value === 'object') {
    const obj = value as GqlObject;
    return executeSelections(obj.__typename, obj, field.selections, variables, doc, ctx, errors);
  }
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>, ctx: GqlContext, operationName?: string | null): GraphQLResult {
  const errors: Array<{ message: string }> = [];
  let doc: Document;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? `Syntax Error: ${err.message}` : String(err) }] };
  }
  const operation = operationName !== undefined && operationName !== null
    ? doc.operations.find((o) => o.name === operationName)
    : doc.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'no operation found in document' }] };
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  try {
    const data = executeSelections(rootType, root, operation.selections, variables, doc, ctx, errors);
    return { data, errors };
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
    return { data: null, errors };
  }
}
