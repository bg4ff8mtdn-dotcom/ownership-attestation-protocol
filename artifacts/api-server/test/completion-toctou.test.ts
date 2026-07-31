import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, tasksTable, taskCompletionsTable, taskHandoffsTable } from "@workspace/db";
import * as taskService from "../src/services/taskService";
import { resetDb, seedActor, closePool } from "./helpers";

/**
 * report_completion time-of-check/time-of-use against a concurrent handoff.
 *
 * reportCompletion reads the task, checks in application code that the caller
 * is the current owner, and only then opens a *separate* transaction to write
 * the completion row and set status. Nothing holds the ownership it verified
 * across that gap, and the status write is unconditional. A handoff that
 * commits inside the gap clears currentOwnerActorId and sets "transitioned" —
 * then the completion writes anyway and overwrites it with "completed".
 *
 * A note on how this is tested. Firing the two operations simultaneously and
 * hoping for the interleaving does not reproduce it: reportCompletion's gap is
 * roughly two round trips wide, while a handoff needs about nine to commit, so
 * the handoff almost always lands after the completion. The natural-timing
 * stress test below therefore passes even against the buggy code, and proves
 * nothing on its own. The first test instead parks the completion at the exact
 * boundary — after its ownership check, before its transaction — and drives
 * the handoff to commit there. The window it exploits is real (two unlocked
 * round trips); only the scheduling is made deterministic.
 */

const STRESS_ATTEMPTS = 25;

describe("report_completion: racing a concurrent handoff", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePool();
  });

  async function acceptedTask(label: string): Promise<{ taskId: string; owner: string }> {
    const injector = await seedActor("injector", "human");
    const owner = await seedActor("owner");
    await seedActor("successor");
    const created = await taskService.createTask({
      title: `completion race ${label}`,
      description: "completion and handoff contend for the same task",
      injectedBy: injector,
    });
    if (!created.ok) throw new Error(`fixture failed: ${created.error}`);

    const accepted = await taskService.acceptTask(created.data.id, { actorId: owner });
    if (!accepted.ok) throw new Error(`fixture failed: ${accepted.error}`);

    return { taskId: created.data.id, owner };
  }

  it("does not finalise a completion whose ownership check was invalidated mid-flight", async () => {
    const { taskId, owner } = await acceptedTask("deterministic");

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Park the *first* db.transaction() call — reportCompletion's — right at
    // the check/use boundary. Handoff's own transaction call is unaffected,
    // because mockImplementationOnce applies to a single invocation and
    // spyOn falls back to the real implementation afterwards.
    const realTransaction = db.transaction.bind(db);
    const spy = vi
      .spyOn(db, "transaction")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementationOnce((async (cb: any) => {
        await barrier;
        return realTransaction(cb);
      }) as never);

    const completionPromise = taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "work finished",
    });

    // Wait until the completion has passed its ownership check and parked.
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // The handoff now commits entirely inside that gap.
    const handoffResult = await taskService.handoffTask(taskId, {
      fromActorId: owner,
      toActorId: "successor",
    });
    expect(handoffResult.ok).toBe(true);

    release();
    const completionResult = await completionPromise;

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    const completions = await db
      .select()
      .from(taskCompletionsTable)
      .where(eq(taskCompletionsTable.taskId, taskId));

    // Ownership moved on before the completion was written, so the completion
    // must not be recorded and must not overwrite the handoff's status.
    expect(completionResult.ok).toBe(false);
    expect(completions).toHaveLength(0);
    expect(task.status).toBe("transitioned");
    expect(task.currentOwnerActorId).toBeNull();
  });

  it("keeps status consistent under natural-timing contention", async () => {
    const inconsistencies: string[] = [];

    for (let attempt = 0; attempt < STRESS_ATTEMPTS; attempt++) {
      await resetDb();
      const { taskId, owner } = await acceptedTask(String(attempt));

      const [, handoffResult] = await Promise.allSettled([
        taskService.reportCompletion(taskId, {
          actorId: owner,
          provenance: "observed",
          claimText: "work finished",
        }),
        taskService.handoffTask(taskId, { fromActorId: owner, toActorId: "successor" }),
      ]);

      const handoffWon = handoffResult.status === "fulfilled" && handoffResult.value.ok === true;
      const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
      const handoffs = await db
        .select()
        .from(taskHandoffsTable)
        .where(eq(taskHandoffsTable.taskId, taskId));

      if (handoffWon && task.status !== "transitioned") {
        inconsistencies.push(
          `attempt ${attempt}: handoff reported ok but status=${task.status}`,
        );
      }
      if (handoffs.length > 0 && task.currentOwnerActorId === null && task.status === "completed") {
        inconsistencies.push(`attempt ${attempt}: completed but handed away`);
      }
    }

    expect(inconsistencies).toEqual([]);
  });
});
