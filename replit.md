# Ownership & Attestation Protocol

A backend protocol that tracks task ownership and provenance across human and AI actors — every task has an auditable trail of who created it, who accepted/owns it, who claims it's done (and how they know), and every handoff between actors.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000 locally / 8080 in workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `MCP_ACCESS_TOKEN` — shared-secret bearer token required to call `/mcp` (see Gotchas)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- MCP: `@modelcontextprotocol/sdk` (Streamable HTTP transport, stateless mode)

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all REST API contracts (gates codegen)
- `artifacts/api-server/src/routes/tasks.ts` — REST route handlers (thin; delegate to the service layer)
- `artifacts/api-server/src/services/taskService.ts` — shared business logic layer (`ServiceResult` pattern: `{ok, status, data}` / `{ok:false, status, error}`). Both REST routes and MCP tools call into this — no logic is duplicated between the two surfaces.
- `artifacts/api-server/src/mcp/tools.ts` — `createTaskMcpServer()` factory defining the 6 MCP tools (create_task, accept_task, report_completion, handoff_task, list_unaccepted_tasks, get_task_status). Each validates with the same `@workspace/api-zod` schemas as REST and calls the same `taskService` functions.
- `artifacts/api-server/src/routes/mcp.ts` — mounts the MCP Streamable HTTP transport at `/mcp` (stateless: one server+transport pair per request), guarded by `mcpAuth`.
- `artifacts/api-server/src/middlewares/mcpAuth.ts` — shared-secret bearer-token check for `/mcp`.
- `artifacts/api-server/.replit-artifact/artifact.toml` — exposes both `/api` and `/mcp` through the shared proxy.

## Architecture decisions

- **Two API surfaces, one service layer.** REST (`/api`) and MCP (`/mcp`) are both thin translation layers over `taskService.ts`. Neither reimplements validation or ownership logic — this guarantees the two surfaces can never drift in behavior.
- **MCP transport is stateless.** Every request to `/mcp` creates a fresh `McpServer` + `StreamableHTTPServerTransport` pair (`sessionIdGenerator: undefined`), torn down when the response closes. There's no server-side session state to manage, which keeps the endpoint simple and safe under concurrent/parallel agent access.
- **MCP auth is intentionally minimal.** `/mcp` requires a single shared-secret bearer token (`MCP_ACCESS_TOKEN`), checked in `mcpAuth` middleware — not OAuth, not per-user. This is sufficient for the current single-tenant/trusted-agent use case; multi-user auth would need a real identity layer.
- **Ownership is first-come-first-served and never silently overwritten.** `accept_task` fails with 409 if a task already has an owner. `handoff_task` is the only way to transfer ownership, and it captures a context snapshot (status, latest acceptance, latest completion) at the moment of transfer for audit purposes.
- **Completions and acceptances are append-only histories, not overwritten fields.** Both `taskService.getTaskStatus` and the `get_task_status` MCP tool return the full history array plus a `latest*` convenience field, so corrected/re-verified claims don't destroy the original record.

## Product

Tasks move through a lifecycle: created (`pending_acceptance`) → accepted by an actor (human or agent) → optionally handed off to another actor → completion reported (with a provenance claim: `observed`, `reviewed`, or `reported`). Every state transition is recorded and queryable, so any actor can audit who did what, when, and how they know it's true. Consumers interact via REST (`/api`) or via MCP tools (`/mcp`) — both backed by identical business logic.

## User preferences

- Build incrementally, one phase at a time; do not proceed to the next phase without explicit user go-ahead.
- Every checkpoint must be independently verified against the database directly (not just API responses or agent claims) before being considered done.

## Gotchas

- `/mcp` requires `Authorization: Bearer <MCP_ACCESS_TOKEN>` on every request (POST). GET and DELETE are rejected with 405 since the transport runs in stateless mode (no long-lived sessions to stream from or terminate). Missing/wrong token or missing server-side config all return 401.
- Whenever `lib/api-spec/openapi.yaml` changes, rerun `pnpm --filter @workspace/api-spec run codegen` before touching REST routes, MCP tools, or the service layer — both surfaces depend on the generated Zod schemas from `@workspace/api-zod`.
- Always restart the `artifacts/api-server: API Server` workflow after code or dependency changes before testing — it rebuilds via esbuild on start.
- When mounting a sub-router with `app.use("/mcp", mcpRouter)`, the routes inside `mcpRouter` must be defined at `"/"`, not `"/mcp"` again, or requests 404 due to path doubling.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
