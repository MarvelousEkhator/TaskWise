import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  addTask,
  completeTask,
  deleteTask,
  getTask,
  isValidDate,
  listTasks,
  updateTask,
  type TaskUpdate,
} from "./tasks.js";
import { buildPlan, formatPlan } from "./planner.js";
import { formatReport, runLaunchGuard } from "./launchguard.js";
import { apiRouter, authConfigWarnings, authRouter, getAuthUser, requireAuth, type AuthUser } from "./auth.js";

const SERVER_NAME = "taskwise";
const SERVER_VERSION = "0.3.0";

// Set ALLOWED_ORIGIN to your site's address in production. "*" is only for local development.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const app = express();

// Render sits behind one proxy. This makes req.ip the visitor's real address.
app.set("trust proxy", 1);

// ---------- Security headers ----------
// The dashboard uses inline <script> and <style>, so those are allowed for this site only.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  })
);

app.use(express.json({ limit: "1mb" }));

// ---------- Dashboard (static files from /public) ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

// ---------- CORS ----------
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  if (ALLOWED_ORIGIN !== "*") res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ---------- Rate limiting ----------
const tooMany = {
  jsonrpc: "2.0",
  error: { code: -32029, message: "Too many requests. Wait a little and try again." },
  id: null,
};

// General limit: 120 requests per minute per visitor.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooMany,
});

// Failed-request limit: 10 failures (like wrong keys) per 15 minutes per visitor.
const failureLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooMany,
});

// Sign-in routes: 30 requests per 15 minutes per visitor.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: tooMany,
});

app.use("/auth", authLimiter, authRouter);
app.use("/api", mcpLimiter, apiRouter);

// ---------- Helpers for tool results ----------
function textResult(...texts: string[]) {
  return { content: texts.map((text) => ({ type: "text" as const, text })) };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error.";
}

const dateSchema = z
  .string()
  .refine(isValidDate, "Use a real date in YYYY-MM-DD format, for example 2026-10-25.");

const prioritySchema = z.enum(["low", "medium", "high"]);

// ---------- MCP server (one per signed-in user) ----------
function buildServer(user: AuthUser) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.tool(
    "add_task",
    "Create a new task. Use when the user asks to add, remember, or note something they need to do. " +
      "Only title is required. Ask the user for a due date or time estimate only if it matters for planning. " +
      "Safe to run without extra confirmation.",
    {
      title: z.string().min(1).describe("What needs to be done"),
      dueDate: dateSchema.optional().describe("Due date as YYYY-MM-DD"),
      priority: prioritySchema.optional().describe("low, medium (default), or high"),
      estimateMinutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .describe("Estimated minutes of work, used by plan_day"),
      notes: z.string().optional().describe("Extra detail about the task"),
    },
    async ({ title, dueDate, priority, estimateMinutes, notes }) => {
      try {
        const task = await addTask(user.id, { title, dueDate, priority, estimateMinutes, notes });
        return textResult(`Added task: "${task.title}" (id: ${task.id})`, JSON.stringify(task));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    }
  );

  server.tool(
    "list_tasks",
    "List the user's tasks. Use to read what is on their list before answering questions about it, " +
      "or to find a task id before updating, completing, or deleting. Read-only.",
    {
      includeCompleted: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set true to also include finished tasks"),
    },
    async ({ includeCompleted }) => {
      try {
        const tasks = await listTasks(user.id, includeCompleted);
        const summary = tasks.length
          ? tasks
              .map(
                (t) =>
                  `- ${t.done ? "[done] " : ""}${t.title} [${t.priority}]` +
                  `${t.dueDate ? ` (due ${t.dueDate})` : ""}` +
                  `${t.estimateMinutes ? ` (~${t.estimateMinutes} min)` : ""}` +
                  ` (id: ${t.id})`
              )
              .join("\n")
          : "No tasks found.";
        return textResult(summary, JSON.stringify(tasks));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    }
  );

  server.tool(
    "update_task",
    "Change an existing task's title, due date, priority, time estimate, or notes. " +
      "Needs the task id (get it from list_tasks). Pass null for dueDate, estimateMinutes, or notes to clear them. " +
      "Moving a due date or changing priority is an important change: tell the user what you will change " +
      "and get their agreement first unless they already asked for exactly that change.",
    {
      id: z.string().describe("Task id from list_tasks"),
      title: z.string().min(1).optional(),
      dueDate: dateSchema.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
      priority: prioritySchema.optional(),
      estimateMinutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .nullable()
        .optional()
        .describe("Minutes, or null to clear"),
      notes: z.string().nullable().optional().describe("Notes, or null to clear"),
    },
    async ({ id, title, dueDate, priority, estimateMinutes, notes }) => {
      const changes: TaskUpdate = {};
      if (title !== undefined) changes.title = title;
      if (dueDate !== undefined) changes.dueDate = dueDate;
      if (priority !== undefined) changes.priority = priority;
      if (estimateMinutes !== undefined) changes.estimateMinutes = estimateMinutes;
      if (notes !== undefined) changes.notes = notes;

      if (Object.keys(changes).length === 0) {
        return errorResult("Nothing to update. Provide at least one field to change.");
      }
      try {
        const task = await updateTask(user.id, id, changes);
        if (!task) return errorResult(`No task found with id ${id}. Use list_tasks to find the right id.`);
        return textResult(`Updated task: "${task.title}"`, JSON.stringify(task));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    }
  );

  server.tool(
    "complete_task",
    "Mark a task as done. Use when the user says they finished something. Needs the task id (from list_tasks).",
    { id: z.string().describe("Task id from list_tasks") },
    async ({ id }) => {
      try {
        const task = await completeTask(user.id, id);
        if (!task) return errorResult(`No task found with id ${id}. Use list_tasks to find the right id.`);
        return textResult(`Marked "${task.title}" as done.`, JSON.stringify(task));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    }
  );

  server.tool(
    "delete_task",
    "Permanently delete a task. This cannot be undone. Never call with confirm=true on your own: " +
      "first show the user the task title and ask them to confirm, then call again with confirm=true. " +
      "If the user only wants it finished, use complete_task instead.",
    {
      id: z.string().describe("Task id from list_tasks"),
      confirm: z
        .boolean()
        .describe("Must be true, and only after the user explicitly confirmed the deletion"),
    },
    async ({ id, confirm }) => {
      try {
        const task = await getTask(user.id, id);
        if (!task) return errorResult(`No task found with id ${id}. Use list_tasks to find the right id.`);
        if (confirm !== true) {
          return textResult(
            `Not deleted. Ask the user to confirm deleting "${task.title}", then call delete_task again with confirm=true.`
          );
        }
        await deleteTask(user.id, id);
        return textResult(`Deleted task: "${task.title}".`);
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    }
  );

  server.tool(
    "plan_day",
    "Build a prioritized plan from the user's pending tasks. Overdue tasks come first, then earlier due dates, " +
      "then higher priority. If availableMinutes is given, it shows what fits and what does not, and flags an " +
      "overloaded day. It does NOT see calendar events, so do not claim the day is conflict-free. " +
      "This only recommends; it never changes any task.",
    {
      date: dateSchema.optional().describe("Day to plan as YYYY-MM-DD. Defaults to today (UTC)"),
      availableMinutes: z
        .number()
        .int()
        .positive()
        .max(1440)
        .optional()
        .describe("Minutes the user has free. Ask for this if they want to know what fits"),
    },
    async ({ date, availableMinutes }) => {
      try {
        const pending = await listTasks(user.id, false);
        const plan = buildPlan(pending, { date, availableMinutes });
        return textResult(formatPlan(plan), JSON.stringify(plan));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    }
  );

  // LaunchGuard shows project settings, so only the admin account gets this tool.
  if (user.isAdmin) {
    server.tool(
      "launchguard_report",
      "DEVELOPER MODE ONLY. Run LaunchGuard, a read-only launch-readiness check of this project's files and settings: " +
        "build and test setup, secrets in files, security configuration, API and backend health, UX basics, and documentation. " +
        "Use only when the developer explicitly asks for LaunchGuard or a launch-readiness check. Never call it during normal " +
        "task or planning conversations. It changes nothing and never shows secret values. It does not run builds or tests, and " +
        "it is not a penetration test: never tell the user the app is 'secure'. Report findings with their CONFIRMED, SUSPECTED, " +
        "or NEEDS MANUAL REVIEW label. Never apply fixes automatically: describe the change and get the developer's agreement first.",
      {
        minSeverity: z
          .enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"])
          .optional()
          .describe("Lowest severity to show. Defaults to INFO (everything)"),
      },
      async ({ minSeverity }) => {
        try {
          const report = runLaunchGuard();
          return textResult(formatReport(report, minSeverity ?? "INFO"), JSON.stringify(report));
        } catch (err) {
          return errorResult(errorMessage(err));
        }
      }
    );
  }

  return server;
}

// ---------- MCP endpoint (stateless) ----------
// A new server + transport is created for every request, so sessions are disabled.
app.post("/mcp", failureLimiter, mcpLimiter, requireAuth, async (req: Request, res: Response) => {
  const server = buildServer(getAuthUser(res));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", errorMessage(err));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless servers do not support streaming GET or session DELETE.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
});

// Return JSON (not an HTML page) for malformed request bodies.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(400).json({
    jsonrpc: "2.0",
    error: { code: -32700, message: "Invalid JSON in request body." },
    id: null,
  });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`${SERVER_NAME} server v${SERVER_VERSION} running on port ${PORT}`);
  for (const warning of authConfigWarnings()) console.warn(`Warning: ${warning}`);
  if (!process.env.TASKWISE_API_KEY) {
    console.warn("Note: TASKWISE_API_KEY is not set, so the owner API key for agents is off.");
  }
  if (ALLOWED_ORIGIN === "*") console.warn("Warning: ALLOWED_ORIGIN is '*'. Restrict it in production.");
});