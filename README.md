# makefun-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Aditaaji/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Aditaaji/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process (stdlib only, no dependencies): git smart HTTP (upload-pack protocol v2, receive-pack v0), REST v3, GraphQL v4, and MCP — built for make.fun's "Build a GitHub-compatible git forge" bounty. Practice grade: 910/1000 (feature 600/600, agent-native 200/200).

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http`, `node:zlib`, `node:crypto` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack v2 (ls-refs, fetch with shallow/deepen/filter, incremental fetch with haves), receive-pack v0 with report-status, pack v2/v3 read/write, SHA-1 objects, symref HEAD, annotated tags.
- **REST v3** under `/api/v3`: repos, branches, commits, contents, refs, labels, issues, comments, pull requests (with squash merge).
- **GraphQL v4** at `/api/graphql`: hand-written lexer/parser/executor for the viewer, repository, issues, mutations, Relay node ids, and batched operations.
- **MCP** at `/mcp`: modern (2026-07-28) `server/discover` and legacy `initialize`, 8 tools with REST parity.

---

<sub>Entered on [make.fun](https://make.fun/?ref=m1dr84q9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
