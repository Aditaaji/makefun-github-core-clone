# Check results — github-core-clone-01

Repo: https://github.com/Aditaaji/makefun-github-core-clone
Kit: `~/workspace/makefun/kit/github-core-clone-01-kit/github-core-clone-01-kit/`
Command: `node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/github-core-clone-01 --driver process --worktree --save <dir>`

## Smoke test (own harness, /tmp/smoke.mts)

64 PASS, 0 FAIL (REST, git smart HTTP, GraphQL, MCP).

## grade-local — trial 0 only (grade-local-1, before the 4 fixes)

- Score **862/1000**: feature 580/600 (116/120), agent 187/200 (14/15 MCP), perf 95/200
- 4 failing checks: `git.fetch-incremental`, `git.fetch-shallow-deepen`, `mcp.rest-parity`, `repos.commits`
- Fixes applied (committed): held-object exclusion in fetch, shallow-boundary have-closure, missing VIEWER_LOGIN import in mcp.ts, no trailing "\n" on commit messages

## grade-local — trial 0 only, after fixes (grade-local-2)

- Score **910/1000**: feature **600/600 (120/120)**, agent **200/200 (15/15)**, perf 110/200 (push 35, clone 32, read 27, write 16), perf_p50_us 704305
- Failed checks: NONE
- Also includes perf optimizations: Adler-32 stream-end finding in pack inflate (2 inflations/object instead of ~20), early-exit fast-forward, memoized history verification

## grade-local — all 3 practice trials (grade-local-3, after fixes)

- Trial 0: **908** (feature 600, agent 200, perf 108)
- Trial 1: **907** (feature 600, agent 200, perf 107)
- Trial 2: **873** (feature 600, agent 200, perf 73)
- **Mean: 896/1000**; 90% interval of the primary column 862.41 – 929.59
- 3 finished, 0 timeout, 0 nondeterministic; 3 of 3 stores working; replay matched byte-for-byte
- Perf varies run to run (73–110) — the local VM has 1.5 shared CPUs and other builders run concurrently; the production sandbox has 2 dedicated CPUs, so local perf is pessimistic.

## Eligibility (from grade-local output)

- ranked: yes; prize: no; efficiency: no — all three "no"s are the missing transcripts (`no_transcripts`, `coverage_below_gate`, `cost_unpriced`), fixed by bundling the build session (see TRANSCRIPTS.md).
- Scored round: every entry runs 1 scored instance; top 60 (+ ties) run all 3, ranked on mean; must beat the house reference forge with a 90% paired t-interval > 0 to take a prize.
