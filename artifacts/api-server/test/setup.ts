/**
 * Runtime assertion that the pinning done in vitest.config.ts actually took
 * effect in this worker.
 *
 * This cannot set DATABASE_URL — by the time a setup file runs, @workspace/db
 * has already been imported and its pool constructed. It exists purely to
 * fail the run loudly if the pool ended up pointed anywhere other than a
 * loopback throwaway instance, rather than letting the suite quietly write
 * fixtures into a real database.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error("DATABASE_URL was not pinned by vitest.config.ts; refusing to run tests.");
}

let parsed: URL;
try {
  parsed = new URL(url);
} catch {
  throw new Error(`DATABASE_URL is not a valid URL: ${url}`);
}

if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
  throw new Error(
    `Tests resolved to database host "${parsed.hostname}", which is not loopback. ` +
      `Refusing to run — see vitest.config.ts.`,
  );
}
