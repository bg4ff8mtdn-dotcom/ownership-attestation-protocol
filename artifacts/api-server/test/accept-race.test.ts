import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, tasksTable, taskAcceptancesTable } from "@workspace/db";
import * as taskService from "../src/services/taskService";
import { resetDb, seedActor, seedActors, closePool, okResults } from "./helpers";

/**
 * Regression coverage for the accept_task ownership race.
 *
 * This race was found and fixed previously (acceptTask now claims ownership
 * with a single conditional UPDATE guarded on currentOwnerActorId IS NULL),
 * but nothing pinned the fix in place. These tests exist so a regression to a
 * read-then-write implementation fails loudly.
 *
 * Invariant under test: "Every task has zero or one current owner", and
 * "Ownership changes only through explicit Acceptance".
 */

const CONTENDERS = 8;

describe("accept_task: concurrent ownership claims", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closePool();
  });

  async function createOpenTask(): Promise<string> {
    const injector = await seedActor("injector", "human");
    const created = await taskService.createTask({
      title: "contended task",
      description: "many actors will race to accept this",
      injectedBy: injector,
    });
    if (!created.ok) throw new Error(`fixture failed: ${created.error}`);
    return created.data.id;
  }

  it("lets exactly one of many simultaneous accepts win", async () => {
    const taskId = await createOpenTask();
    const contenders = await seedActors("agent", CONTENDERS);

    const settled = await Promise.allSettled(
      contenders.map((actorId) => taskService.acceptTask(taskId, { actorId })),
    );

    const winners = okResults(settled);
    expect(winners).toHaveLength(1);
  });

  it("records exactly one acceptance row and one matching owner", async () => {
    const taskId = await createOpenTask();
    const contenders = await seedActors("agent", CONTENDERS);

    await Promise.allSettled(
      contenders.map((actorId) => taskService.acceptTask(taskId, { actorId })),
    );

    const acceptances = await db
      .select()
      .from(taskAcceptancesTable)
      .where(eq(taskAcceptancesTable.taskId, taskId));
    expect(acceptances).toHaveLength(1);

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    expect(task.currentOwnerActorId).toBe(acceptances[0]!.actorId);
    expect(task.status).toBe("accepted");
  });

  it("rejects losing accepts with 409, not a silent no-op", async () => {
    const taskId = await createOpenTask();
    const contenders = await seedActors("agent", CONTENDERS);

    const settled = await Promise.allSettled(
      contenders.map((actorId) => taskService.acceptTask(taskId, { actorId })),
    );

    const losers = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<{ ok: boolean; status: number }>).value)
      .filter((v) => !v.ok);

    expect(losers).toHaveLength(CONTENDERS - 1);
    for (const loser of losers) {
      expect(loser.status).toBe(409);
    }
  });
});
