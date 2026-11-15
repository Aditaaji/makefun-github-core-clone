// Entrypoint: bring the graded server up, tell the trial env where it
// listens, and stay alive until the env reports the trial is finished.
// The scored work lives in app.ts; this file only runs the env handshake.

import { createApp } from "./app.ts";

// The env's origin comes from MAKEFUN_ENV_URL (http://store:8080 inside a
// trial pod). A trailing slash is trimmed so the URLs below stay simple.
const rawOrigin = process.env.MAKEFUN_ENV_URL ?? "";
const envOrigin = rawOrigin.replace(/\/+$/, "");
if (envOrigin === "") {
  process.stderr.write("[entry] MAKEFUN_ENV_URL is empty: no env to talk to\n");
  process.exit(1);
}

// One HTTP call may take this long before it is dropped and retried.
const CALL_BUDGET_MS = 30_000;
// Retries wait this long first, doubling each time up to the ceiling.
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((wake) => setTimeout(wake, ms));

// Wait after `failures` failed calls: start low, double, never past the cap.
function backoffMs(failures: number): number {
  let wait = BACKOFF_START_MS;
  for (let step = 0; step < failures && wait < BACKOFF_LIMIT_MS; step += 1) {
    wait *= 2;
  }
  return Math.min(wait, BACKOFF_LIMIT_MS);
}

// Tell the env which port the server bound. 200 registers us; 409 means a
// first registration already won and is not ours to fix. 400 and 405 are
// contract errors and stop the program; anything else is retried, since the
// env may still be starting up.
async function announce(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register failed: HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("register failed: HTTP ")) throw err;
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Ask the env whether the trial is over, polling until it says it is.
async function awaitDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // No answer yet, or the call timed out: the trial is not done.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Bind an ephemeral port, register it, then wait for the env to finish.
async function boot(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write("[entry] registered with the env\n");

  await awaitDone();
  server.close();
  process.stdout.write("[entry] trial done\n");
}

boot()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[entry] failed: ${detail}\n`);
    process.exit(1);
  });
