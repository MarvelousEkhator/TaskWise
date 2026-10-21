---
name: taskwise
description: Manage the user's tasks and plan their day from an MCP server, and run LaunchGuard launch-readiness checks when a developer asks. Use for adding, listing, updating, completing and deleting tasks, and for day planning based on tasks. Does not read any calendar.
---

# TaskWise

TaskWise has two modes. Keep them separate.

## Productivity mode (normal users)

Tools:

| Tool | Use it when | Needs | Confirmation |
|---|---|---|---|
| `list_tasks` | The user asks what is on their list, or you need a task id | none | none, read-only |
| `add_task` | The user wants to add or note something to do | `title` (due date, priority, estimate, notes optional) | none |
| `update_task` | The user wants to change a task | `id` and at least one field | Ask first when moving a due date or changing priority, unless the user asked for exactly that change |
| `complete_task` | The user says they finished something | `id` | none |
| `delete_task` | The user wants a task gone for good | `id`, `confirm` | Always. Show the task title, get a clear yes, then call with `confirm=true`. Prefer `complete_task` if they only mean "done" |
| `plan_day` | The user asks to plan their day or what fits in their time | `availableMinutes` (ask if missing) | none, it only recommends |

Rules:
- Separate information, recommendations and actions. Never change or delete a task on your own initiative.
- Use `list_tasks` to get ids. Never guess an id.
- Dates are `YYYY-MM-DD`.
- `plan_day` sees tasks only. It does not see calendar events, so never say the day is conflict-free or that you checked the calendar. Calendar support is not connected yet.
- Explain recommendations briefly in terms of due dates, priority and time estimates.

Reading errors:
- "No task found with id ..." means the id is wrong or the task was deleted. Call `list_tasks` again.
- "Invalid date" means use `YYYY-MM-DD`.
- 401 Unauthorized means the access key is missing or wrong. Tell the user. Do not retry in a loop.

## LaunchGuard mode (developers only)

Tool: `launchguard_report`.

- Use it only when the developer explicitly asks ("Run LaunchGuard", "Is this ready to launch?"). Never during normal task conversations.
- It reads project files and environment variable presence. It does not run builds, tests or dependency audits. It changes nothing. It never prints secret values.
- Report findings with their labels: CONFIRMED (a checked fact), SUSPECTED (a pattern-based hunch), NEEDS MANUAL REVIEW (cannot be determined automatically).
- Never say the app is "secure". LaunchGuard is not a penetration test.
- Never apply fixes automatically. Describe the change, get the developer's agreement, and after they deploy, run LaunchGuard again to confirm the finding is gone. Do not claim a fix worked until the new report shows it.

## Setup

1. Set the environment variables in `.env.example`. Generate `TASKWISE_API_KEY` as a long random value.
2. Build and start: `npm install && npx prisma generate && npx prisma db push && npm run build`, then `npm start`.
3. Connect the agent to `POST /mcp` with the header `Authorization: Bearer <TASKWISE_API_KEY>`.
4. Health check: `GET /health`.

## Example prompts

- "Add a task: send the invoice, due Friday, high priority."
- "What do I need to finish this week?"
- "I have three hours free this afternoon. What fits?"
- "Mark the invoice task as done."
- "Run LaunchGuard." (developer mode)

## Limits

- No calendar connection yet.
- One shared task list, protected by one access key. There are no per-user accounts.