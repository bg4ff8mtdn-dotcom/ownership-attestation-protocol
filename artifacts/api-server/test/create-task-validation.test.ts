import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as taskService from "../src/services/taskService";
import { resetDb, seedActor, closePool } from "./helpers";

/**
 * create_task actor validation.
 *
 * injected_by is a NOT NULL foreign key into actors. Before this was checked
 * in application code, passing an unknown actor produced a database-level
 * foreign key violation whose driver error was returned to the caller intact —
 * leaking the full INSERT statement, every column name and the bound
 * parameters to anyone holding an API token, in place of a useful message.
 */

describe("create_task: actor validation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closePool();
  });

  it("returns 404 for an actor that does not exist", async () => {
    const result = await taskService.createTask({
      title: "orphan",
      description: "injected by nobody",
      injectedBy: "no-such-actor",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
    expect(result.error).toContain("no-such-actor");
  });

  it("does not leak SQL or bound parameters in the error", async () => {
    const result = await taskService.createTask({
      title: "orphan",
      description: "injected by nobody",
      injectedBy: "no-such-actor",
    });

    if (result.ok) throw new Error("expected failure");
    const error = result.error.toLowerCase();
    expect(error).not.toContain("insert into");
    expect(error).not.toContain("failed query");
    expect(error).not.toContain("params:");
    expect(error).not.toContain("current_owner_actor_id");
  });

  it("still creates the task when the actor exists", async () => {
    const injector = await seedActor("real-injector", "human");

    const result = await taskService.createTask({
      title: "valid",
      description: "injected by a known actor",
      injectedBy: injector,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.status).toBe(201);
    expect(result.data.status).toBe("pending_acceptance");
    expect(result.data.currentOwnerActorId).toBeNull();
  });
});
