/**
 * Local development helper: insert an actor row.
 *
 * Every protocol tool takes an actor id and every one of them requires that
 * actor to already exist — tasks.injected_by, task_acceptances.actor_id and
 * the rest are NOT NULL foreign keys into actors. The protocol deliberately
 * exposes no way to create one: actor identity is an input to OAP, not
 * something OAP issues, so there is no create_actor tool and no REST route.
 * On a real deployment actors are provisioned by whatever system already owns
 * identity.
 *
 * That leaves a fresh local checkout unusable until at least one actor exists,
 * which is what this script is for. It is intentionally a plain script run
 * directly with pnpm — never imported by the server, never reachable over
 * HTTP, and not part of the protocol surface.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed-actor <actor-id> [human|agent] [display name]
 */

import { db, actorsTable } from "@workspace/db";

async function main(): Promise<void> {
  const [id, rawType, ...nameParts] = process.argv.slice(2);

  if (!id) {
    console.error(
      "Usage: pnpm --filter @workspace/scripts run seed-actor <actor-id> [human|agent] [display name]",
    );
    process.exit(1);
  }

  const type = rawType ?? "agent";
  if (type !== "human" && type !== "agent") {
    console.error(`Invalid actor type "${type}". Must be "human" or "agent".`);
    process.exit(1);
  }

  const displayName = nameParts.length > 0 ? nameParts.join(" ") : id;

  const inserted = await db
    .insert(actorsTable)
    .values({ id, type, displayName })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    console.log(`Actor "${id}" already exists; nothing to do.`);
  } else {
    console.log(`Created actor "${id}" (${type}, "${displayName}").`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
