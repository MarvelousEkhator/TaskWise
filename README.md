# TaskWise

TaskWise is an AI-agent skill and MCP server that manages your tasks and calendar, plans realistic days, and flags conflicts and overload. It also includes **LaunchGuard**, a built-in developer mode that checks whether a project is ready to launch.

> Formerly AlexaTasker.

## Status

TaskWise is under active development. This table is the honest picture of what exists today versus what is planned.

| Area | Status |
| --- | --- |
| MCP server (Streamable HTTP, `POST /mcp`) | Working |
| Health check (`GET /health`) | Working |
| Task tools | Working (verify the tool list in `src/`) |
| `plan_day` (due-date-sorted planner) | Working, basic |
| Web dashboard | Working, Add button being fixed (MCP handshake) |
| Calendar integration | Planned |
| Conflict and overload detection | Planned |
| Task breakdown | Planned |
| LaunchGuard (local readiness checker) | Planned |

## How it works

TaskWise has two clearly separated modes.

**Productivity Mode** (for everyday users) reads, creates, updates and completes tasks, and plans your day around deadlines and priorities. It separates information, recommendations and actions, and asks for confirmation before important or destructive changes.

**LaunchGuard Mode** (for developers) runs locally inside a project. It inspects structure, scripts, build, tests, lint and types, configuration, secrets (values are never printed), API handling, and docs, then produces a readiness report. It is not a penetration-testing tool and never claims a project is completely secure.

## Tech stack

Node.js, TypeScript, Express, `@modelcontextprotocol/sdk`, zod.

## Project layout

```
src/         MCP server and tools
dashboard/   Static web dashboard
```

## Getting started

Requirements: Node.js (use the version in `package.json` or `.nvmrc`).

```bash
git clone https://github.com/GroveGoals/TaskWise.git
cd TaskWise
npm install
npm run build
npm start
```

> Check these script names against `package.json` and adjust if they differ.

The server exposes:

- `GET /health` for health checks
- `POST /mcp` for MCP over Streamable HTTP

## Configuration

Set environment variables in a local `.env` file (never commit it) or in your host's settings.

| Variable | Purpose |
| --- | --- |
| `PORT` | Port the server listens on (if used) |
| _add the rest from your code_ | |

Never commit secrets, tokens, or credentials.

## Using the MCP server

Every client must follow the MCP handshake:

1. Send `initialize` and read the `Mcp-Session-Id` response header.
2. Send `notifications/initialized`.
3. Send `tools/call` requests with the `Mcp-Session-Id` header.

Send `Accept: application/json, text/event-stream` on every POST. Responses may arrive as server-sent events.

## Deployment (Render)

- **Backend:** a Web Service using the build and start commands above, with health check path `/health`.
- **Dashboard:** a Static Site with publish directory `dashboard`.
- Set the backend's CORS allowed origin to your dashboard URL, and point the dashboard at your backend URL.

## Example prompts

- "Plan my day tomorrow."
- "What do I need to finish this week?"
- "I have three hours free this afternoon. What should I work on?"

## Roadmap

Calendar integration, conflict and overload detection, task breakdown, LaunchGuard, and packaging as an installable agent skill (`SKILL.md`).

## License

MIT License

Copyright (c) 2026 Marvelous Osagieduwa Henry Ekhator .
