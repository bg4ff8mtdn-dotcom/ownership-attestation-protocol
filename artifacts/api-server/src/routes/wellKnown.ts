import { Router, type IRouter } from "express";

const serverCard = {
  serverInfo: {
    name: "Ownership & Attestation Protocol",
    version: "1.0.1",
  },
  authentication: {
    required: true,
    schemes: ["bearer"],
  },
  tools: [
    {
      name: "create_task",
      description:
        "Creates a task in pending_acceptance state. Nothing is owned until explicitly accepted.",
    },
    {
      name: "accept_task",
      description:
        "Explicitly accepts a task, making the calling actor its current owner. Fails if the task already has a different current owner.",
    },
    {
      name: "report_completion",
      description:
        "Reports a task as complete. Requires a provenance value (observed, reviewed, or reported) — rejected if missing or invalid.",
    },
    {
      name: "handoff_task",
      description:
        "Transfers task ownership, capturing a frozen snapshot of state at the moment of transfer. The recipient must call accept_task themselves before acting as owner.",
    },
    {
      name: "get_task_status",
      description:
        "Returns the complete history for a task: injection, all acceptances, all completion claims with provenance, all handoffs.",
    },
    {
      name: "list_unaccepted_tasks",
      description: "Returns tasks with no current owner.",
    },
  ],
  resources: [],
  prompts: [],
};

const router: IRouter = Router();

// Intentionally public: this is descriptive metadata for MCP client
// discovery (e.g. Smithery), not a way to call the actual tools. Must NOT
// require the bearer token, unlike every other /api or /mcp route.
router.get("/mcp/server-card.json", (_req, res) => {
  res.json(serverCard);
});

export default router;
