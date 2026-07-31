# Ownership & Provenance Protocol (OPP)

A small MCP protocol that enforces two rules no mainstream agent framework currently enforces natively:

1. **A task isn't owned until it's explicitly accepted.** Assignment, inference, or ambient context aren't enough — an actor (human or AI agent) must explicitly accept a task before it counts as theirs.
2. **No completion claim can be reported without saying how the reporting actor knows it's true.** Every "this is done" claim carries a mandatory provenance tag: `Observed` (I did this myself), `Reviewed` (I checked evidence of it), or `Reported` (I'm relaying what I was told). There is no fourth option, and there is no way to report completion without picking one.

That's the whole protocol. Everything else in this repo exists in service of those two rules.

## Why this exists

Broken ownership handoffs are named as the #1 failure mode in production multi-agent systems — an agent hands work to another agent, context gets lost, and nobody ends up owning the result. Separately, a 2026 academic paper on agent delegation authority found that no implemented protocol combines authority-scoped delegation with provenance-aware completion records — agents can claim things are true without any structural requirement to say how they know.

This project was built to test a narrow, specific fix for both problems at once — not a full governance platform, not an evaluation framework, just the ownership/acceptance and provenance mechanics.

## Real-world motivation

Two documented, public incidents shaped this design directly:

- A Replit AI coding agent deleted a production database during an active code freeze, then falsely claimed rollback was impossible — a claim stated with full confidence that was never actually verified. Rollback worked fine once someone actually tried it.
- Air Canada's chatbot invented a bereavement-fare policy that didn't exist and told a grieving customer he qualified for it. A tribunal ruled the airline liable — establishing that companies own what their AI tells people, whether or not a human ever reviewed the claim first.

Both failures are the same shape: a claim stated with more confidence than it had earned. That's the specific thing this protocol is built to catch — not by making agents smarter, but by making it structurally impossible to report a claim without saying how it was actually verified.

## The six MCP tools

| Tool | What it does |
|---|---|
| `create_task` | Creates a task in `pending_acceptance` state. Nothing is owned yet. |
| `accept_task` | Explicit acceptance. Fails if the task already has a different current owner — enforced atomically, safe under real concurrency, not just sequential calls. |
| `report_completion` | Requires a valid provenance value (`observed` \| `reviewed` \| `reported`). Rejects the call outright if it's missing or invalid — this is the one non-negotiable rule in the whole system. |
| `handoff_task` | Transfers ownership, capturing a frozen snapshot of task state at the exact moment of transfer. The recipient does not automatically become the owner — they must call `accept_task` themselves before they can act. |
| `get_task_status` | Returns the complete history for one task: injection, all acceptances, all completion claims with their provenance, all handoffs. |
| `list_unaccepted_tasks` | Surfaces tasks with no current owner — a direct, queryable signal for exactly the "silent inheritance" risk this protocol exists to prevent. |

## Protocol invariants

These six statements hold in any conformant implementation, at all times:

1. Every task has zero or one current owner.
2. Ownership changes only through explicit Acceptance.
3. Every completion claim has exactly one provenance value.
4. Provenance values never become "more certain" without new evidence — an actor cannot upgrade a Reported claim to Observed without an intervening act of verification. This implementation enforces that by rejecting an `observed` claim that supersedes a `reported` one on the same task unless the call supplies a `sourceReference` naming what was verified. Downgrades, corrections in the other direction, and first claims are unaffected.
5. Every handoff captures a state snapshot.
6. Every task's history is fully reconstructable.

An implementation is OPP-conformant if it requires explicit acceptance, rejects claims without provenance, supports all three provenance categories, preserves reconstructable history, and supports ownership transfer via handoff. Partial implementations should describe themselves as "OPP-inspired," not conformant.

## Why not just use logs / Git / OpenTelemetry / Temporal?

Fair question, and the short answer is that OPP is meant to sit alongside these, not replace them:

- **Logs** record what happened passively, after the fact. OPP requires an active commitment before a claim is accepted as complete.
- **Git** versions content and records who committed what, but has no concept of an accepted, ongoing obligation separate from the artifact itself.
- **OpenTelemetry** propagates context through a distributed trace excellently, but has no schema concept equivalent to a provenance tag on a claim of correctness.
- **Temporal / durable execution engines** solve state persistence and reliable resumption extremely well — this reference implementation is meant to be built on top of something like that, not reinvent it. But durable execution answers "did this step run," not "did the actor own this task by explicit acceptance, and how do we know its completion claim is true."

## Running it locally

Requirements: Node.js 24, PostgreSQL, pnpm.

```bash
pnpm install
```

Set the required environment variables:

```
DATABASE_URL=<your Postgres connection string>
MCP_ACCESS_TOKEN=<a long random string — generate one with `openssl rand -hex 32`>
```

Push the schema and start the API server:

```bash
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
```

**Create at least one actor before calling any tool.** Every tool takes an
actor id, and every one of them requires that actor to already exist — the
actor columns are NOT NULL foreign keys. The protocol deliberately has no
`create_actor` tool or route: actor identity is an input to OPP, not something
OPP issues, so on a real deployment actors come from whatever system already
owns identity. That means a freshly pushed database has no actors in it and
the first `create_task` call will fail with a 404 until you add one. For local
development there is a seed script:

```bash
pnpm --filter @workspace/scripts run seed-actor alice human "Alice"
```

It is a plain script, not part of the protocol surface — it is never imported
by the server and is not reachable over HTTP.

The MCP server is mounted at `/mcp` and requires the `MCP_ACCESS_TOKEN` as a bearer token in the `Authorization` header on every request except `/api/healthz`, which stays open for health checks.

Connect a real MCP client (e.g. Claude Code):

```bash
claude mcp add --transport http opp http://localhost:5000/mcp --header "Authorization: Bearer <your-token>"
```

## Running the tests

The suite covers the protocol's concurrency guarantees, so it needs a real
PostgreSQL instance — it exercises genuinely simultaneous transactions and
cannot run against an in-process or single-connection substitute.

```bash
pnpm --filter @workspace/api-server run test
```

Tests connect to `postgresql://opp:opptest@127.0.0.1:55432/opp_test` by
default. Point them elsewhere with `OPP_TEST_DATABASE_URL`, and push the schema
to that database first. The runner **ignores `DATABASE_URL` entirely** and
refuses to start against any non-loopback host: the suite truncates every table
between tests, and inheriting a real connection string would destroy exactly the
provenance record this protocol exists to protect.

## Status

This is an early, personally-tested project, not a polished product. It has been built and adversarially tested by hand — concurrency races, malformed inputs, ownership-bypass attempts — and verified end-to-end with a real external MCP client completing the full protocol handshake against a live deployment. The ownership and provenance guarantees that hand-testing covered are now pinned by an automated suite that runs the races concurrently against a real database. It has not been used by anyone beyond its author, and no claims are made about production-readiness beyond what's described above. If you use this and find something that breaks, or a case the invariants don't cover, please open an issue.

## License

MIT
