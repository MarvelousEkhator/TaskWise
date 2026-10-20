import type { Priority, Task } from "./tasks.js";

// Used only when a task has no estimate. The plan always says when this was assumed.
export const DEFAULT_ESTIMATE_MINUTES = 30;

export interface PlanOptions {
  /** Plan date as YYYY-MM-DD. Defaults to today (UTC). */
  date?: string;
  /** Minutes the person actually has free. If omitted, no time-fitting is done. */
  availableMinutes?: number;
}

export interface PlannedTask {
  task: Task;
  minutes: number;
  estimateAssumed: boolean;
  overdue: boolean;
}

export interface PlanResult {
  date: string;
  availableMinutes?: number;
  scheduled: PlannedTask[];
  unscheduled: PlannedTask[];
  totalMinutes: number;
  scheduledMinutes: number;
  overloaded: boolean;
  notes: string[];
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function compareTasks(a: PlannedTask, b: PlannedTask): number {
  // 1. Overdue first
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  // 2. Earlier due date first; tasks without a due date go last
  const aDue = a.task.dueDate ?? "9999-12-31";
  const bDue = b.task.dueDate ?? "9999-12-31";
  if (aDue !== bDue) return aDue.localeCompare(bDue);
  // 3. Higher priority first
  const byPriority = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
  if (byPriority !== 0) return byPriority;
  // 4. Oldest first
  return a.task.createdAt.localeCompare(b.task.createdAt);
}

export function buildPlan(tasks: Task[], options: PlanOptions = {}): PlanResult {
  const date = options.date ?? todayUtc();
  const pending = tasks.filter((t) => !t.done);

  const planned: PlannedTask[] = pending
    .map((task) => ({
      task,
      minutes: task.estimateMinutes ?? DEFAULT_ESTIMATE_MINUTES,
      estimateAssumed: task.estimateMinutes === undefined,
      overdue: task.dueDate !== undefined && task.dueDate < date,
    }))
    .sort(compareTasks);

  const totalMinutes = planned.reduce((sum, p) => sum + p.minutes, 0);
  const notes: string[] = [];
  const scheduled: PlannedTask[] = [];
  const unscheduled: PlannedTask[] = [];

  if (options.availableMinutes === undefined) {
    scheduled.push(...planned);
  } else {
    let remaining = options.availableMinutes;
    for (const item of planned) {
      if (item.minutes <= remaining) {
        scheduled.push(item);
        remaining -= item.minutes;
      } else {
        unscheduled.push(item);
      }
    }
  }

  const scheduledMinutes = scheduled.reduce((sum, p) => sum + p.minutes, 0);
  const overloaded =
    options.availableMinutes !== undefined && totalMinutes > options.availableMinutes;

  const overdueCount = planned.filter((p) => p.overdue).length;
  if (overdueCount > 0) {
    notes.push(`${overdueCount} task(s) are overdue and are placed first.`);
  }
  const assumedCount = planned.filter((p) => p.estimateAssumed).length;
  if (assumedCount > 0) {
    notes.push(
      `${assumedCount} task(s) have no time estimate, so ${DEFAULT_ESTIMATE_MINUTES} minutes each was assumed.`
    );
  }
  if (overloaded) {
    notes.push(
      `Workload is ${totalMinutes} min but only ${options.availableMinutes} min are available. ` +
        `Consider moving the unscheduled tasks, shrinking them, or freeing more time.`
    );
  }
  if (options.availableMinutes === undefined && planned.length > 0) {
    notes.push("No available time was given, so tasks are ordered but not checked against your day.");
  }
  notes.push("Calendar events are not considered because no calendar is connected yet.");

  return {
    date,
    availableMinutes: options.availableMinutes,
    scheduled,
    unscheduled,
    totalMinutes,
    scheduledMinutes,
    overloaded,
    notes,
  };
}

function describe(p: PlannedTask): string {
  const parts: string[] = [];
  if (p.task.dueDate) parts.push(`due ${p.task.dueDate}${p.overdue ? ", OVERDUE" : ""}`);
  parts.push(`${p.task.priority} priority`);
  parts.push(`${p.minutes} min${p.estimateAssumed ? " (assumed)" : ""}`);
  return `${p.task.title} (${parts.join(", ")})`;
}

export function formatPlan(result: PlanResult): string {
  if (result.scheduled.length === 0 && result.unscheduled.length === 0) {
    return `No pending tasks for ${result.date}. Your day is open.`;
  }

  const lines: string[] = [`Plan for ${result.date}:`];

  if (result.scheduled.length > 0) {
    lines.push("", "Do these, in this order:");
    result.scheduled.forEach((p, i) => lines.push(`${i + 1}. ${describe(p)}`));
    lines.push(`Total: ${result.scheduledMinutes} min.`);
  }

  if (result.unscheduled.length > 0) {
    lines.push("", "Does not fit in the time available:");
    result.unscheduled.forEach((p) => lines.push(`- ${describe(p)}`));
  }

  if (result.notes.length > 0) {
    lines.push("", "Notes:");
    result.notes.forEach((n) => lines.push(`- ${n}`));
  }

  return lines.join("\n");
}
