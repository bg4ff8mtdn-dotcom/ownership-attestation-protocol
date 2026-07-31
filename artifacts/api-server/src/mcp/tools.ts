import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateTaskBody,
  AcceptTaskParams,
  AcceptTaskBody,
  ReportCompletionParams,
  ReportCompletionBody,
  HandoffTaskParams,
  HandoffTaskBody,
  ListUnacceptedTasksQueryParams,
  GetTaskStatusParams,
} from "@workspace/api-zod";
import * as taskService from "../services/taskService";

/**
 * MCP tool layer. This is a thin translation layer only: every tool
 * validates its input using the exact same zod schemas the REST routes use
 * (imported from @workspace/api-zod, generated from the OpenAPI spec), then
 * delegates to the exact same shared service functions in
 * src/services/taskService.ts that the REST routes call. No validation or
 * ownership logic is reimplemented here.
 *
 * Each tool returns a ServiceResult-derived MCP result: on success, the
 * data as JSON text content; on failure, the same {status, error} the REST
 * API would have produced, as JSON text content with isError: true.
 */

function toolResult(result: { ok: boolean; status: number; data?: unknown; error?: string }) {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ status: result.status, error: result.error }, null, 2) },
    ],
    isError: true,
  };
}

export function createTaskMcpServer(): McpServer {
  // Keep in step with the version published in server.json. A deployment
  // reporting a different version in its initialize response than the registry
  // advertises is a quiet lie to every client that inspects serverInfo.
  const server = new McpServer({
    name: "ownership-provenance-protocol",
    version: "1.0.1",
  });

  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description:
        "Creates a task. Status always starts as pending_acceptance.",
      inputSchema: CreateTaskBody.shape,
    },
    async (args) => {
      const result = await taskService.createTask(args);
      return toolResult(result);
    },
  );

  server.registerTool(
    "accept_task",
    {
      title: "Accept a task",
      description:
        "Claims ownership of a task for the calling actor. Fails with a 409 if the task " +
        "already has a current owner (first-come, first-served; ownership can never be " +
        "silently overwritten).",
      inputSchema: {
        ...AcceptTaskParams.shape,
        ...AcceptTaskBody.shape,
      },
    },
    async (args) => {
      const { taskId, ...body } = args;
      const result = await taskService.acceptTask(taskId, body);
      return toolResult(result);
    },
  );

  server.registerTool(
    "report_completion",
    {
      title: "Report a task completion",
      description:
        "Records a completion claim for a task. provenance must be exactly one of observed, " +
        "reviewed, or reported. Only the task's current owner may report completion. Multiple " +
        "completions per task are allowed by design (a corrected/better-verified claim may " +
        "supersede an earlier one) — use get_task_status's latestCompletion field for the " +
        "currently applicable claim.",
      inputSchema: {
        ...ReportCompletionParams.shape,
        ...ReportCompletionBody.shape,
      },
    },
    async (args) => {
      const { taskId, ...body } = args;
      const result = await taskService.reportCompletion(taskId, body);
      return toolResult(result);
    },
  );

  server.registerTool(
    "handoff_task",
    {
      title: "Hand off a task to another actor",
      description:
        "Transfers ownership of a task from its current owner to another actor, capturing a " +
        "context snapshot (status, latest acceptance, latest completion) at the exact moment " +
        "of the call. Only the task's current owner may initiate a handoff. On success the " +
        "task's owner is cleared until the new actor calls accept_task.",
      inputSchema: {
        ...HandoffTaskParams.shape,
        ...HandoffTaskBody.shape,
      },
    },
    async (args) => {
      const { taskId, ...body } = args;
      const result = await taskService.handoffTask(taskId, body);
      return toolResult(result);
    },
  );

  server.registerTool(
    "list_unaccepted_tasks",
    {
      title: "List all tasks with no current owner",
      description:
        "Returns all tasks with no current owner (never accepted yet, or handed off and not " +
        "yet re-accepted), optionally filtered to tasks injected for one specific actor.",
      inputSchema: ListUnacceptedTasksQueryParams.shape,
    },
    async (args) => {
      const result = await taskService.listUnacceptedTasks(args);
      return toolResult(result);
    },
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Get the complete history for one task",
      description:
        "Returns a task's current state (including its current owner, if any), its most " +
        "recent acceptance record, every completion claim ever reported plus the currently " +
        "applicable one (latestCompletion), and every handoff (with its context snapshot).",
      inputSchema: GetTaskStatusParams.shape,
    },
    async (args) => {
      const result = await taskService.getTaskStatus(args.taskId);
      return toolResult(result);
    },
  );

  return server;
}
