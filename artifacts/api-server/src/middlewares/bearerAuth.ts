import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Minimal shared-secret bearer token check, shared by both the /mcp
 * transport and the protected /api/tasks* REST routes.
 *
 * This is deliberately simple (not OAuth, not per-user accounts): every
 * caller (human or agent) currently shares a single trusted secret. The goal
 * is only "not wide open to anyone who finds the URL," not enterprise auth.
 * Revisit this if these endpoints ever need to support more than one caller
 * with distinct identities/permissions.
 */

/**
 * RFC 7235 §2.1 defines the authentication scheme as a case-insensitive
 * token, so `bearer <token>` is exactly as valid as `Bearer <token>`. Matching
 * the scheme case-sensitively rejected conformant clients with a 401 that
 * looked identical to a wrong secret, which is a miserable thing to debug.
 */
const BEARER_SCHEME = /^bearer[ \t]+(.+)$/i;

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = BEARER_SCHEME.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Constant-time comparison. A plain `!==` on secrets returns as soon as it
 * finds a differing byte, so how long the comparison takes is a function of
 * how many leading bytes were correct. Hashing both sides first gives two
 * equal-length digests, which sidesteps timingSafeEqual's requirement that
 * inputs match in length — and avoids leaking the expected token's length
 * through that error path.
 */
function secureEquals(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const expectedToken = process.env["MCP_ACCESS_TOKEN"];
  if (!expectedToken) {
    req.log.error("MCP_ACCESS_TOKEN is not configured; rejecting request");
    res.status(401).json({ error: "Server is not configured" });
    return;
  }

  const providedToken = extractBearerToken(req.header("authorization"));

  if (!providedToken || !secureEquals(providedToken, expectedToken)) {
    req.log.warn({ path: req.path }, "Rejected request: missing or incorrect bearer token");
    res.status(401).json({ error: "Missing or invalid bearer token" });
    return;
  }

  next();
}
