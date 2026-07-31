import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { bearerAuth } from "../src/middlewares/bearerAuth";

/**
 * Auth middleware behaviour.
 *
 * These tests are transport-level and touch no database, so they build a
 * minimal app around the middleware rather than importing the real one. The
 * stub logger stands in for pino-http, which normally attaches req.log.
 */

const TOKEN = "a".repeat(64);

function buildApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    // pino-http would normally provide this.
    (req as unknown as { log: unknown }).log = {
      warn: () => undefined,
      error: () => undefined,
    };
    next();
  });
  app.get("/protected", bearerAuth, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("bearerAuth", () => {
  let previousToken: string | undefined;

  beforeEach(() => {
    previousToken = process.env["MCP_ACCESS_TOKEN"];
    process.env["MCP_ACCESS_TOKEN"] = TOKEN;
  });

  afterEach(() => {
    if (previousToken === undefined) {
      delete process.env["MCP_ACCESS_TOKEN"];
    } else {
      process.env["MCP_ACCESS_TOKEN"] = previousToken;
    }
  });

  it("accepts the canonical 'Bearer' scheme", async () => {
    await request(buildApp())
      .get("/protected")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
  });

  it("accepts a lowercase 'bearer' scheme (RFC 7235 is case-insensitive)", async () => {
    await request(buildApp())
      .get("/protected")
      .set("Authorization", `bearer ${TOKEN}`)
      .expect(200);
  });

  it("accepts mixed-case scheme spellings", async () => {
    await request(buildApp())
      .get("/protected")
      .set("Authorization", `BeArEr ${TOKEN}`)
      .expect(200);
  });

  it("still rejects an incorrect token", async () => {
    await request(buildApp())
      .get("/protected")
      .set("Authorization", `Bearer ${"b".repeat(64)}`)
      .expect(401);
  });

  it("rejects a token of a different length", async () => {
    await request(buildApp())
      .get("/protected")
      .set("Authorization", "Bearer short")
      .expect(401);
  });

  it("rejects a missing Authorization header", async () => {
    await request(buildApp()).get("/protected").expect(401);
  });

  it("rejects a non-bearer scheme carrying the right secret", async () => {
    await request(buildApp())
      .get("/protected")
      .set("Authorization", `Basic ${TOKEN}`)
      .expect(401);
  });

  it("rejects the scheme with no credentials", async () => {
    await request(buildApp()).get("/protected").set("Authorization", "Bearer").expect(401);
  });

  it("rejects every request when the server has no token configured", async () => {
    delete process.env["MCP_ACCESS_TOKEN"];
    await request(buildApp())
      .get("/protected")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(401);
  });
});
