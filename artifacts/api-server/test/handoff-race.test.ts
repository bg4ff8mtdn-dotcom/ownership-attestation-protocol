import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, tasksTable, taskHandoffsTable } from "@workspace/db";
import * as taskService from "../src/services/taskService";
import { resetDb, seedActor, seedActors, closePool, okResults } from "./helpers";

/**
 * handoff_task concurrency.
 *
 * acceptTask claims ownership with a single conditional UPDATE guarded on
 * currentOwnerActorId, so two accepts can never both win. handoffTask does
 * not use that pattern: it reads the task with a plain SELECT inside its
 * transaction, checks ownership in application code, and only later issues
 * the UPDATE. Under READ COMMITTED — Postgres' default, and what this service
 * runs at — a plain SELECT takes no row lock, so two concurrent handoffs from
 * the same owner can both observe themselves as the owner, both pass the
 * check, and both commit a handoff row.
 *
 * The damage is not a failed call, it is a false record: the task ends up with
 * two recorded handoffs to two different recipients for a single transfer of
 * ownership, and both recipients have equal claim to a task only one of them
 * can accept. That is precisely the "broken handoff" failure the protocol
 * exists to make impossible.
 */

const RECIPIENTS = 6;

describe("handoff_task: concurrent handoffs from the same owner", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closePool();
  });

  async function acceptedTask(): Promise<{ taskId: string; owner: string }> {
    const injector = await seedActor("injector", "human");
    const owner = await seedActor("owner");
    const created = await taskService.createTask({
      title: "handoff target",
      description: "owner will be raced into multiple handoffs",
      injectedBy: injector,
    });
    if (!created.ok) throw new Error(`fixture failed: ${created.error}`);

    const accepted = await taskService.acceptTask(created.data.id, { actorId: owner });
    if (!accepted.ok) throw new Error(`fixture failed: ${accepted.error}`);

    return { taskId: created.data.id, owner };
  }

  it("lets exactly one of many simultaneous handoffs win", async () => {
    const { taskId, owner } = await acceptedTask();
    const recipients = await seedActors("recipient", RECIPIENTS);

    const settled = await Promise.allSettled(
      recipients.map((toActorId) =>
        taskService.handoffTask(taskId, { fromActorId: owner, toActorId }),
      ),
    );

    const winners = okResults(settled);
    expect(winners).toHaveLength(1);
  });

  it("records exactly one handoff row for a single transfer of ownership", async () => {
    const { taskId, owner } = await acceptedTask();
    const recipients = await seedActors("recipient", RECIPIENTS);

    await Promise.allSettled(
      recipients.map((toActorId) =>
        taskService.handoffTask(taskId, { fromActorId: owner, toActorId }),
      ),
    );

    const handoffs = await db
      .select()
      .from(taskHandoffsTable)
      .where(eq(taskHandoffsTable.taskId, taskId));

    expect(handoffs).toHaveLength(1);
  });

  it("clears ownership exactly once and leaves the task transitioned", async () => {
    const { taskId, owner } = await acceptedTask();
    const recipients = await seedActors("recipient", RECIPIENTS);

    await Promise.allSettled(
      recipients.map((toActorId) =>
        taskService.handoffTask(taskId, { fromActorId: owner, toActorId }),
      ),
    );

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    expect(task.currentOwnerActorId).toBeNull();
    expect(task.status).toBe("transitioned");
  });

  it("rejects losing handoffs rather than silently recording them", async () => {
    const { taskId, owner } = await acceptedTask();
    const recipients = await seedActors("recipient", RECIPIENTS);

    const settled = await Promise.allSettled(
      recipients.map((toActorId) =>
        taskService.handoffTask(taskId, { fromActorId: owner, toActorId }),
      ),
    );

    const losers = settled
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<{ ok: boolean }>).value)
      .filter((v) => !v.ok);

    expect(losers).toHaveLength(RECIPIENTS - 1);
  });
});
