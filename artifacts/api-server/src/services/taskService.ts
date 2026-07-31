import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  tasksTable,
  actorsTable,
  taskAcceptancesTable,
  taskCompletionsTable,
  taskHandoffsTable,
} from "@workspace/db";

/**
 * Shared business-logic layer for tasks. Both the REST routes
 * (src/routes/tasks.ts) and the MCP tools (src/mcp/tasks.ts) call these
 * functions so ownership/validation/transaction logic is implemented
 * exactly once. Callers are responsible for validating raw input against
 * the @workspace/api-zod schemas *before* calling into this layer — these
 * functions assume already-validated input.
 *
 * Every function returns a ServiceResult so callers (REST or MCP) can map
 * `status` to their own transport's error representation without needing
 * to re-derive it from thrown errors.
 */

export type ServiceResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string };

function ok<T>(status: number, data: T): ServiceResult<T> {
  return { ok: true, status, data };
}

function fail<T = never>(status: number, error: string): ServiceResult<T> {
  return { ok: false, status, error };
}

export interface CreateTaskInput {
  title: string;
  description: string;
  injectedBy: string;
  authorityScope?: string | null;
}

export async function createTask(input: CreateTaskInput) {
  // injectedBy is a NOT NULL foreign key to actors. Without this check the
  // insert fails at the database level and the driver's error — which carries
  // the full SQL statement and its parameter list — is handed back to the
  // caller verbatim. acceptTask and reportCompletion already validate their
  // actors this way; createTask was the one path that did not.
  const [actor] = await db
    .select()
    .from(actorsTable)
    .where(eq(actorsTable.id, input.injectedBy));
  if (!actor) {
    return fail(404, `Actor ${input.injectedBy} not found`);
  }

  const [task] = await db
    .insert(tasksTable)
    .values({
      title: input.title,
      description: input.description,
      injectedBy: input.injectedBy,
      authorityScope: input.authorityScope ?? null,
    })
    .returning();

  return ok(201, task);
}

export interface AcceptTaskInput {
  actorId: string;
  contextNote?: string | null;
}

export async function acceptTask(taskId: string, input: AcceptTaskInput) {
  const { actorId, contextNote } = input;

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    return fail(404, `Task ${taskId} not found`);
  }

  const [actor] = await db.select().from(actorsTable).where(eq(actorsTable.id, actorId));
  if (!actor) {
    return fail(404, `Actor ${actorId} not found`);
  }

  // Atomic ownership claim: a single conditional UPDATE that only succeeds
  // if no one currently holds ownership. This is the race-condition-proof
  // equivalent of the old unique constraint — there is no separate
  // read-then-write step, so two concurrent accept attempts cannot both
  // "see" a null owner and both proceed to write.
  const acceptance = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(tasksTable)
      .set({ status: "accepted", currentOwnerActorId: actorId })
      .where(and(eq(tasksTable.id, taskId), isNull(tasksTable.currentOwnerActorId)))
      .returning({ id: tasksTable.id });

    if (claimed.length !== 1) {
      return null;
    }

    const [row] = await tx
      .insert(taskAcceptancesTable)
      .values({
        taskId,
        actorId,
        contextNote: contextNote ?? null,
      })
      .returning();

    return row;
  });

  if (!acceptance) {
    const [current] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    return fail(
      409,
      current?.currentOwnerActorId === actorId
        ? `Task ${taskId} is already owned by ${actorId}`
        : `Task ${taskId} is already owned by ${current?.currentOwnerActorId}; ` +
            `${actorId} cannot accept it`,
    );
  }

  return ok(201, acceptance);
}

export interface ReportCompletionInput {
  actorId: string;
  provenance: "observed" | "reviewed" | "reported";
  claimText: string;
  sourceReference?: string | null;
}

export async function reportCompletion(taskId: string, input: ReportCompletionInput) {
  const { actorId, provenance, claimText, sourceReference } = input;

  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    return fail(404, `Task ${taskId} not found`);
  }

  const [actor] = await db.select().from(actorsTable).where(eq(actorsTable.id, actorId));
  if (!actor) {
    return fail(404, `Actor ${actorId} not found`);
  }

  // The reads above produce clean 404s, but they are not the ownership
  // guard — they cannot be. Checking ownership here and writing later leaves a
  // gap in which a concurrent handoff can clear the owner and set
  // "transitioned", after which this call would still write its completion and
  // unconditionally overwrite that status. The task would then report itself
  // completed while owned by nobody, carrying a claim from an actor that had
  // already handed the work away.
  //
  // So ownership is asserted by the status UPDATE itself, inside the same
  // transaction as the insert, exactly as acceptTask asserts its claim: if the
  // caller is no longer the current owner the UPDATE matches zero rows and the
  // whole transaction is abandoned.
  const completion = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(tasksTable)
      .set({ status: "completed" })
      .where(and(eq(tasksTable.id, taskId), eq(tasksTable.currentOwnerActorId, actorId)))
      .returning({ id: tasksTable.id });

    if (claimed.length !== 1) {
      return null;
    }

    const [row] = await tx
      .insert(taskCompletionsTable)
      .values({
        taskId,
        actorId,
        provenance,
        claimText,
        sourceReference: sourceReference ?? null,
      })
      .returning();

    return row;
  });

  if (!completion) {
    const [current] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    if (!current) {
      return fail(404, `Task ${taskId} not found`);
    }
    if (current.currentOwnerActorId === null) {
      return fail(
        409,
        `Task ${taskId} has no current owner; ${actorId} must call accept_task first`,
      );
    }
    return fail(
      403,
      `Task ${taskId} is currently owned by ${current.currentOwnerActorId}; ` +
        `${actorId} cannot report completion`,
    );
  }

  return ok(201, completion);
}

export interface HandoffTaskInput {
  fromActorId: string;
  toActorId: string;
  reason?: string | null;
}

export async function handoffTask(taskId: string, input: HandoffTaskInput) {
  const { fromActorId, toActorId, reason } = input;

  const [fromActor] = await db.select().from(actorsTable).where(eq(actorsTable.id, fromActorId));
  if (!fromActor) {
    return fail(404, `Actor ${fromActorId} not found`);
  }

  const [toActor] = await db.select().from(actorsTable).where(eq(actorsTable.id, toActorId));
  if (!toActor) {
    return fail(404, `Actor ${toActorId} not found`);
  }

  try {
    const handoff = await db.transaction(async (tx) => {
      // Capture the context snapshot inside the same transaction so it
      // reflects a single, consistent moment in time.
      //
      // FOR UPDATE is load-bearing here. A plain SELECT takes no row lock
      // under READ COMMITTED, so two concurrent handoffs from the same owner
      // could both read themselves as the current owner, both pass the checks
      // below, and both commit — recording two transfers to two different
      // recipients for a single change of ownership. Locking the row
      // serialises them: the second transaction blocks here, then re-reads and
      // finds ownership already cleared.
      const [task] = await tx
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .for("update");
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      if (task.currentOwnerActorId === null) {
        throw new Error(`Task ${taskId} has no current owner; ${fromActorId} cannot hand it off`);
      }

      if (task.currentOwnerActorId !== fromActorId) {
        throw new Error(
          `Task ${taskId} is currently owned by ${task.currentOwnerActorId}, not ${fromActorId}; ` +
            `handoff rejected`,
        );
      }

      const [latestAcceptance] = await tx
        .select()
        .from(taskAcceptancesTable)
        .where(eq(taskAcceptancesTable.taskId, taskId))
        .orderBy(desc(taskAcceptancesTable.acceptedAt))
        .limit(1);

      const [latestCompletion] = await tx
        .select()
        .from(taskCompletionsTable)
        .where(eq(taskCompletionsTable.taskId, taskId))
        .orderBy(desc(taskCompletionsTable.reportedAt))
        .limit(1);

      const contextSnapshot = {
        capturedAt: new Date().toISOString(),
        status: task.status,
        latestAcceptance: latestAcceptance
          ? {
              id: latestAcceptance.id,
              actorId: latestAcceptance.actorId,
              acceptedAt: latestAcceptance.acceptedAt,
              contextNote: latestAcceptance.contextNote,
            }
          : null,
        latestCompletion: latestCompletion
          ? {
              id: latestCompletion.id,
              actorId: latestCompletion.actorId,
              provenance: latestCompletion.provenance,
              claimText: latestCompletion.claimText,
              sourceReference: latestCompletion.sourceReference,
              reportedAt: latestCompletion.reportedAt,
            }
          : null,
      };

      // Defensive check: never allow an empty/null snapshot to be persisted,
      // even though contextSnapshot is NOT NULL at the DB level too.
      if (!contextSnapshot || typeof contextSnapshot !== "object") {
        throw new Error("Failed to capture a valid context snapshot");
      }

      const [row] = await tx
        .insert(taskHandoffsTable)
        .values({
          taskId,
          fromActorId,
          toActorId,
          reason: reason ?? null,
          contextSnapshot,
        })
        .returning();

      // Atomic conditional release, mirroring the conditional claim in
      // acceptTask: the UPDATE itself re-asserts ownership rather than
      // trusting the earlier read. The row lock above already guarantees
      // exclusivity, so this should never fail — asserting the affected row
      // count keeps that guarantee explicit instead of leaving it implicit in
      // the isolation level.
      const released = await tx
        .update(tasksTable)
        .set({ status: "transitioned", currentOwnerActorId: null })
        .where(and(eq(tasksTable.id, taskId), eq(tasksTable.currentOwnerActorId, fromActorId)))
        .returning({ id: tasksTable.id });

      if (released.length !== 1) {
        throw new Error(`Task ${taskId} ownership changed during handoff; handoff rejected`);
      }

      return row;
    });

    return ok(201, handoff);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to capture context snapshot";
    const status = message.startsWith(`Task ${taskId} not found`)
      ? 404
      : message.includes("ownership changed during handoff")
        ? 409
        : message.includes("cannot hand it off") || message.includes("handoff rejected")
          ? 403
          : 400;
    return fail(status, message);
  }
}

export interface ListUnacceptedTasksInput {
  actorId?: string;
}

export async function listUnacceptedTasks(input: ListUnacceptedTasksInput) {
  const { actorId } = input;

  const tasks = await db
    .select()
    .from(tasksTable)
    .where(
      actorId
        ? and(isNull(tasksTable.currentOwnerActorId), eq(tasksTable.injectedBy, actorId))
        : isNull(tasksTable.currentOwnerActorId),
    );

  return ok(200, { tasks });
}

export async function getTaskStatus(taskId: string) {
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) {
    return fail(404, `Task ${taskId} not found`);
  }

  const acceptances = await db
    .select()
    .from(taskAcceptancesTable)
    .where(eq(taskAcceptancesTable.taskId, taskId))
    .orderBy(taskAcceptancesTable.acceptedAt);

  // acceptances is chronological; the currently-applicable acceptance is
  // simply the last one created. Kept as a distinct field rather than
  // inferred by callers, mirroring latestCompletion below — re-acceptance
  // after a handoff is legitimate and creates a new row, so a task can
  // have multiple acceptances over its lifetime.
  const latestAcceptance = acceptances.length > 0 ? acceptances[acceptances.length - 1] : null;

  const completions = await db
    .select()
    .from(taskCompletionsTable)
    .where(eq(taskCompletionsTable.taskId, taskId))
    .orderBy(taskCompletionsTable.reportedAt);

  // completions is chronological; the currently-applicable claim is simply
  // the last one reported. Kept as a distinct field rather than inferred
  // by callers, since multiple completions per task are allowed by design
  // (e.g. a corrected, better-verified claim superseding an earlier one).
  const latestCompletion = completions.length > 0 ? completions[completions.length - 1] : null;

  const handoffs = await db
    .select()
    .from(taskHandoffsTable)
    .where(eq(taskHandoffsTable.taskId, taskId))
    .orderBy(taskHandoffsTable.handoffAt);

  return ok(200, {
    task,
    acceptances,
    latestAcceptance,
    completions,
    latestCompletion,
    handoffs,
  });
}
