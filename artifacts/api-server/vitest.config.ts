import { defineConfig } from "vitest/config";

/**
 * The database URL is pinned here rather than in a setup file on purpose.
 *
 * @workspace/db constructs its connection pool from process.env.DATABASE_URL
 * at import time, and that import is resolved through Node's loader before
 * setupFiles execute. Anything set in a setup file is therefore too late —
 * the pool is already pointed at whatever DATABASE_URL the shell happened to
 * export. test.env is applied to the worker environment before any module in
 * the graph is evaluated, which is the only reliable place to override it.
 *
 * The guard is fail-closed: tests never inherit DATABASE_URL, only
 * TEST_DATABASE_URL, and refuse to start unless it resolves to a loopback
 * host. Writing this suite's fixtures into a real database — the developer's
 * own, or worse a deployed one — would corrupt exactly the provenance record
 * the protocol exists to keep trustworthy.
 */

const DEFAULT_LOCAL_URL = "postgresql://opp:opptest@127.0.0.1:55432/opp_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Deliberately project-scoped. A bare TEST_DATABASE_URL is a common name and
// is very likely to already be exported on a developer machine for some other
// project — if it is, this suite would silently adopt that database and start
// truncating its tables.
const OVERRIDE_VAR = "OPP_TEST_DATABASE_URL";

function resolveTestDatabaseUrl(): string {
  const raw = process.env[OVERRIDE_VAR] ?? DEFAULT_LOCAL_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a valid URL: ${raw}`);
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing to run tests against non-loopback database host "${parsed.hostname}". ` +
        `Set ${OVERRIDE_VAR} to a local throwaway Postgres, or leave it unset ` +
        `to use ${DEFAULT_LOCAL_URL}.`,
    );
  }

  return raw;
}

const TEST_DATABASE_URL = resolveTestDatabaseUrl();

// Mutating process.env here (config module scope, main process, before any
// worker is forked) is what actually pins the value: workers inherit this
// environment at spawn, so @workspace/db sees it no matter how early in the
// module graph it is evaluated. test.env below is a second belt for workers
// that re-read configuration rather than inheriting it.
process.env["DATABASE_URL"] = TEST_DATABASE_URL;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
    },
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // The race tests coordinate concurrent transactions against a single
    // shared database. Running suites in parallel would interleave their
    // fixtures, so file-level parallelism is disabled here.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
