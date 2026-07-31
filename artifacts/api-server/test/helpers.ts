import { sql } from "drizzle-orm";
import { db, pool, actorsTable } from "@workspace/db";

/**
 * Fixtures for the protocol test suite. Imported only from test files, which
 * run after test/setup.ts has pinned DATABASE_URL to a loopback throwaway
 * instance — never import this from application code.
 */

/** Wipes every protocol table. CASCADE covers the FK graph in one statement. */
export async function resetDb(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE task_handoffs, task_completions, task_acceptances, tasks, actors CASCADE`,
  );
}

/**
 * Inserts an actor directly. There is deliberately no create_actor tool or
 * route in the protocol surface, so tests seed actors at the table level the
 * same way an operator would.
 */
export async function seedActor(id: string, type: "human" | "agent" = "agent"): Promise<string> {
  await db
    .insert(actorsTable)
    .values({ id, type, displayName: id })
    .onConflictDoNothing();
  return id;
}

/** Seeds N agent actors named `${prefix}-0` … `${prefix}-(n-1)`. */
export async function seedActors(prefix: string, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  await Promise.all(ids.map((id) => seedActor(id)));
  return ids;
}

/** Releases the shared pool so vitest can exit cleanly. */
export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Narrows an array of settled results to the service calls that reported
 * success. Rejected promises (thrown errors) count as failures, not successes.
 */
export function okResults<T extends { ok: boolean }>(
  settled: PromiseSettledResult<T>[],
): T[] {
  return settled
    .filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v) => v.ok);
}
