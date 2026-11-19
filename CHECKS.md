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

## Perf push 2 — grade-local 3-trial A/B, same VM load (this session)

Server CPU/op measured first (hammer, `/proc` CPU time): read 0.168 -> 0.126 ms/op
(-25%), push 1.218 -> 1.040 ms/op (-15%), write/clone within noise. A 100us-interval
CPU profile of push-only showed no single hotspot (GC ~10% of busy CPU, writev ~9%,
zlib ~5%, the rest spread over HTTP machinery, hashing and handlers), so the
remaining gains are thin.

Optimizations (committed here):
- git.ts `inflateObject`: one `inflateSync(tail, { info: true })` — the engine's
  `bytesWritten` is the consumed input length, so no second inflate and no Adler-32
  scan per object (isolated bench: 45.1 -> 30.3 ms per 600-object pass, -33%;
  edge cases verified: empty blob, 1 MB blob, truncated stream throws, trailing
  garbage ignored). Binary-search fallback kept for a missing/invalid length.
- app.ts `routeOf`: manual request-target parse instead of `new URL` (~7 us/req),
  dot segments resolved as URL does, per-segment percent-decoding unchanged.
- app.ts: `x-github-request-id` is a monotonic counter instead of `randomUUID()`
  (kit checks only require it non-empty); GET/HEAD skip the `readBody` listeners;
  serialized-issue cache (`issueJsonText`, signature over every output field) for
  the 2,000 identical GETs in the read workload.

A/B, 3 trials each, back-to-back under the same heavy VM load (old code stashed
for the control):
- New code (grade-local-perf3-3t): mean **938** (perf **138**, p50 482 us) — trials 925/950/938.
  Per-workload means: push 39, clone 31, read 35, write 33.
- Old code (grade-local-baseline3): mean **929** (perf **129**, p50 541 us) — trials 928/924/935.
  Per-workload means: push 37, clone 34, read 30, write 28.
- Gain: **+9 score / +9 perf, p50 -11%**, but the 90% intervals overlap
  (new 917–959, old 920–938) and per-workload noise is +/-5 points, so the gain is
  real in direction (matches the CPU/op measurements) but small in magnitude.
- A single trial run mid-session under even heavier load scored 909 (perf 109,
  grade-local-perf3); for reference the same code measured 975–980 when the VM was
  quiet, so local numbers move +/-50 with VM load alone.

Conclusion: +28 perf (dev 123 -> 151 for rank 100) is NOT reachable by
micro-optimization of this TypeScript entry. The gap is structural: the server
runs ~2.2x slower than this VM (dev p50 576 us vs local ~258 us when quiet) and
the top entries are Go+SIMD; the remaining per-request cost is Node HTTP
machinery, GC and zlib spread thin with no dominant hotspot. A Go rewrite would
be a different entry and is out of scope for this push.

## Perf push — grade-local 3-trial means (earlier session, same VM)

Baseline fresh (grade-local-baseline, HEAD adf0163, VM loaded by other builders):
mean 918 (perf 118, p50 630993) — push 1125 ms, clone 283 ms, read 1921 ms, write 262 ms.

Optimizations (committed here):
- Fetch-pack + ls-refs + info/refs response cache in app.ts, keyed by request +
  repo.gitVersion; bumpGit() clears it on every objects/refs mutation (storeObject,
  commitFiles, squashMerge, REST ref create, receive-pack). Objects are
  content-addressed and append-only, so a version-keyed cache cannot go stale.
- readPack inflate merge in git.ts: one helper returns data + consumed length,
  2 inflates per object instead of 3.
- v2 advertisement built once as a module constant.

A/B control, same load (old code stashed, grade-local-baseline2):
- Old code mean **979** (perf 179, p50 267802): push 451, clone 111, read 850, write 122 ms.
- New code run 1 (grade-local-perf1): mean **970** (perf 170, p50 307697).
- New code run 2 (grade-local-perf2): mean **980** (perf 180, p50 258157).
- New code 6-trial combined: mean ~975, perf ~175 — within run-to-run noise of
  the old code (trials range 958–986). Feature 600/600 and agent 200/200 in all
  9 trials; replays matched. Conclusion: the changes maintain the mean locally.
  The local harness shows the real effect under CPU load: clone fetch phase
  211 ms -> 24 ms for 50 concurrent clones (pack cache); under light load the
  fetch handler is not the bottleneck, so grade-local clone is unchanged
  (~111 ms vs ~114 ms). Kept as contention insurance for the production
  sandbox, where the server's dev perf (108, p50 724283) shows CPU is scarcer.
