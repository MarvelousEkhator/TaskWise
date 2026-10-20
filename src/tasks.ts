import { randomUUID } from "crypto";

export type Priority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  dueDate?: string; // YYYY-MM-DD
  priority: Priority;
  estimateMinutes?: number;
  notes?: string;
  done: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface NewTaskInput {
  title: string;
  dueDate?: string;
  priority?: Priority;
  estimateMinutes?: number;
  notes?: string;
}

// For updates: pass null to clear an optional field, omit a field to leave it unchanged.
export interface TaskUpdate {
  title?: string;
  dueDate?: string | null;
  priority?: Priority;
  estimateMinutes?: number | null;
  notes?: string | null;
}

// NOTE: tasks live in memory only. They are lost when the server restarts
// and are shared by everyone who can reach the server.
const tasks: Map<string, Task> = new Map();

/** True only for real calendar dates written as YYYY-MM-DD. */
export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

function assertDate(value: string): void {
  if (!isValidDate(value)) {
    throw new Error(`Invalid date "${value}". Use YYYY-MM-DD, for example 2026-10-25.`);
  }
}

function assertEstimate(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > 1440) {
    throw new Error("estimateMinutes must be a whole number between 1 and 1440.");
  }
}

export function addTask(input: NewTaskInput): Task {
  const title = input.title.trim();
  if (!title) throw new Error("Task title cannot be empty.");
  if (input.dueDate !== undefined) assertDate(input.dueDate);
  if (input.estimateMinutes !== undefined) assertEstimate(input.estimateMinutes);

  const task: Task = {
    id: randomUUID(),
    title,
    dueDate: input.dueDate,
    priority: input.priority ?? "medium",
    estimateMinutes: input.estimateMinutes,
    notes: input.notes?.trim() || undefined,
    done: false,
    createdAt: new Date().toISOString(),
  };
  tasks.set(task.id, task);
  return task;
}

export function listTasks(includeCompleted = false): Task[] {
  return Array.from(tasks.values()).filter((t) => includeCompleted || !t.done);
}

export function getTask(id: string): Task | null {
  return tasks.get(id) ?? null;
}

export function updateTask(id: string, changes: TaskUpdate): Task | null {
  const task = tasks.get(id);
  if (!task) return null;

  // Validate everything first so a bad value never leaves a half-updated task.
  if (changes.title !== undefined && !changes.title.trim()) {
    throw new Error("Task title cannot be empty.");
  }
  if (typeof changes.dueDate === "string") assertDate(changes.dueDate);
  if (typeof changes.estimateMinutes === "number") assertEstimate(changes.estimateMinutes);

  if (changes.title !== undefined) task.title = changes.title.trim();
  if (changes.dueDate !== undefined) task.dueDate = changes.dueDate ?? undefined;
  if (changes.priority !== undefined) task.priority = changes.priority;
  if (changes.estimateMinutes !== undefined) {
    task.estimateMinutes = changes.estimateMinutes ?? undefined;
  }
  if (changes.notes !== undefined) task.notes = changes.notes?.trim() || undefined;
  return task;
}

export function completeTask(id: string): Task | null {
  const task = tasks.get(id);
  if (!task) return null;
  task.done = true;
  task.completedAt = new Date().toISOString();
  return task;
}

export function deleteTask(id: string): boolean {
  return tasks.delete(id);
}
