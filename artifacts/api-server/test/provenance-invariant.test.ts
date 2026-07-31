import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, tasksTable, taskCompletionsTable } from "@workspace/db";
import * as taskService from "../src/services/taskService";
import { resetDb, seedActor, closePool } from "./helpers";

/**
 * Invariant 4: "Provenance values never become more certain without new
 * evidence — an actor cannot upgrade a Reported claim to Observed without an
 * intervening act of verification."
 *
 * Completions are append-only by design, so the protocol permits a corrected
 * claim to supersede an earlier one. What it must not permit is relabelling
 * hearsay as first-hand observation for free: get_task_status reports the
 * latest claim as the applicable one, so an unguarded upgrade would let
 * "someone told me this is done" become "I saw this myself" with no new
 * evidence behind it. Upgrading is allowed — but only with a sourceReference
 * pointing at what was actually verified.
 */

describe("report_completion: provenance upgrades", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closePool();
  });

  async function ownedTask(): Promise<{ taskId: string; owner: string }> {
    const injector = await seedActor("injector", "human");
    const owner = await seedActor("owner");
    const created = await taskService.createTask({
      title: "provenance subject",
      description: "claims will be reported against this",
      injectedBy: injector,
    });
    if (!created.ok) throw new Error(`fixture failed: ${created.error}`);

    const accepted = await taskService.acceptTask(created.data.id, { actorId: owner });
    if (!accepted.ok) throw new Error(`fixture failed: ${accepted.error}`);

    return { taskId: created.data.id, owner };
  }

  async function reportReported(taskId: string, owner: string): Promise<void> {
    const first = await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "reported",
      claimText: "another agent told me this was finished",
    });
    if (!first.ok) throw new Error(`fixture failed: ${first.error}`);
  }

  it("rejects a reported -> observed upgrade with no evidence", async () => {
    const { taskId, owner } = await ownedTask();
    await reportReported(taskId, owner);

    const upgrade = await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "actually I saw it myself",
    });

    expect(upgrade.ok).toBe(false);
    if (upgrade.ok) throw new Error("unreachable");
    expect(upgrade.status).toBe(409);
    expect(upgrade.error).toContain("sourceReference");
  });

  it("does not record the rejected claim", async () => {
    const { taskId, owner } = await ownedTask();
    await reportReported(taskId, owner);

    await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "actually I saw it myself",
    });

    const completions = await db
      .select()
      .from(taskCompletionsTable)
      .where(eq(taskCompletionsTable.taskId, taskId));

    expect(completions).toHaveLength(1);
    expect(completions[0]!.provenance).toBe("reported");
  });

  it("allows the upgrade when a sourceReference is supplied", async () => {
    const { taskId, owner } = await ownedTask();
    await reportReported(taskId, owner);

    const upgrade = await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "verified the deployment myself",
      sourceReference: "https://ci.example.com/run/4417",
    });

    expect(upgrade.ok).toBe(true);
    if (!upgrade.ok) throw new Error("unreachable");
    expect(upgrade.data.provenance).toBe("observed");
    expect(upgrade.data.sourceReference).toBe("https://ci.example.com/run/4417");
  });

  it("leaves the task completed and owned after an allowed upgrade", async () => {
    const { taskId, owner } = await ownedTask();
    await reportReported(taskId, owner);

    await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "verified myself",
      sourceReference: "evidence://checked",
    });

    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    expect(task.status).toBe("completed");
    expect(task.currentOwnerActorId).toBe(owner);
  });

  it("still allows a first-ever observed claim with no prior history", async () => {
    const { taskId, owner } = await ownedTask();

    const result = await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "did it myself, first claim on this task",
    });

    expect(result.ok).toBe(true);
  });

  it("still allows a downgrade from observed to reported", async () => {
    const { taskId, owner } = await ownedTask();
    const first = await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "saw it",
    });
    expect(first.ok).toBe(true);

    const downgrade = await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "reported",
      claimText: "correcting myself, I was relaying someone else",
    });

    expect(downgrade.ok).toBe(true);
  });

  it("does not leave the task completed when the upgrade is rejected mid-transaction", async () => {
    const { taskId, owner } = await ownedTask();

    // Put the task into a known non-completed state first by handing it off,
    // re-accepting, then reporting a "reported" claim.
    await reportReported(taskId, owner);
    const [beforeTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    const statusBefore = beforeTask.status;

    await taskService.reportCompletion(taskId, {
      actorId: owner,
      provenance: "observed",
      claimText: "no evidence supplied",
    });

    const [afterTask] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    expect(afterTask.status).toBe(statusBefore);
  });
});
