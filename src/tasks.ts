import { Prisma, type Task as DbTask } from "@prisma/client";
import { prisma } from "./db.js";

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

// Tasks are stored in Postgres (Neon) via Prisma and survive restarts.
// NOTE: there are no user accounts yet, so tasks are shared by everyone who can reach the server.

function toTask(row: DbTask): Task {
  return {
    id: row.id,
    title: row.title,
    dueDate: row.dueDate ?? undefined,
    priority: row.priority as Priority,
    estimateMinutes: row.estimateMinutes ?? undefined,
    notes: row.notes ?? undefined,
    done: row.done,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

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

export async function addTask(input: NewTaskInput): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error("Task title cannot be empty.");
  if (input.dueDate !== undefined) assertDate(input.dueDate);
  if (input.estimateMinutes !== undefined) assertEstimate(input.estimateMinutes);

  const row = await prisma.task.create({
    data: {
      title,
      dueDate: input.dueDate ?? null,
      priority: input.priority ?? "medium",
      estimateMinutes: input.estimateMinutes ?? null,
      notes: input.notes?.trim() || null,
    },
  });
  return toTask(row);
}

export async function listTasks(includeCompleted = false): Promise<Task[]> {
  const rows = await prisma.task.findMany({
    where: includeCompleted ? {} : { done: false },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toTask);
}

export async function getTask(id: string): Promise<Task | null> {
  const row = await prisma.task.findUnique({ where: { id } });
  return row ? toTask(row) : null;
}

export async function updateTask(id: string, changes: TaskUpdate): Promise<Task | null> {
  // Validate everything first so a bad value never leaves a half-updated task.
  if (changes.title !== undefined && !changes.title.trim()) {
    throw new Error("Task title cannot be empty.");
  }
  if (typeof changes.dueDate === "string") assertDate(changes.dueDate);
  if (typeof changes.estimateMinutes === "number") assertEstimate(changes.estimateMinutes);

  const data: Prisma.TaskUpdateInput = {};
  if (changes.title !== undefined) data.title = changes.title.trim();
  if (changes.dueDate !== undefined) data.dueDate = changes.dueDate;
  if (changes.priority !== undefined) data.priority = changes.priority;
  if (changes.estimateMinutes !== undefined) data.estimateMinutes = changes.estimateMinutes;
  if (changes.notes !== undefined) data.notes = changes.notes?.trim() || null;

  try {
    const row = await prisma.task.update({ where: { id }, data });
    return toTask(row);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function completeTask(id: string): Promise<Task | null> {
  try {
    const row = await prisma.task.update({
      where: { id },
      data: { done: true, completedAt: new Date() },
    });
    return toTask(row);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function deleteTask(id: string): Promise<boolean> {
  const result = await prisma.task.deleteMany({ where: { id } });
  return result.count > 0;
}