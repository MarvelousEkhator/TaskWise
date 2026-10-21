import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, formatPlan, DEFAULT_ESTIMATE_MINUTES } from "../src/planner.js";
import type { Task } from "../src/tasks.js";

const DATE = "2026-10-21";

function task(overrides: Partial<Task> & { title: string }): Task {
  return {
    id: overrides.title,
    priority: "medium",
    done: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const order = (tasks: Task[], availableMinutes?: number) =>
  buildPlan(tasks, { date: DATE, availableMinutes }).scheduled.map((p) => p.task.title);

test("an empty list says the day is open", () => {
  const plan = buildPlan([], { date: DATE });
  assert.equal(plan.scheduled.length, 0);
  assert.equal(formatPlan(plan), `No pending tasks for ${DATE}. Your day is open.`);
});

test("finished tasks are left out", () => {
  const plan = buildPlan([task({ title: "done one", done: true }), task({ title: "open one" })], {
    date: DATE,
  });
  assert.deepEqual(plan.scheduled.map((p) => p.task.title), ["open one"]);
});

test("overdue tasks come first, even with lower priority", () => {
  const plan = buildPlan(
    [
      task({ title: "soon", dueDate: "2026-10-22", priority: "high" }),
      task({ title: "late", dueDate: "2026-10-19", priority: "low" }),
    ],
    { date: DATE }
  );
  assert.deepEqual(plan.scheduled.map((p) => p.task.title), ["late", "soon"]);
  assert.equal(plan.scheduled[0].overdue, true);
  assert.ok(plan.notes.includes("1 task(s) are overdue and are placed first."));
});

test("a task due today is not overdue", () => {
  const plan = buildPlan([task({ title: "today", dueDate: DATE })], { date: DATE });
  assert.equal(plan.scheduled[0].overdue, false);
});

test("earlier due dates come before later ones", () => {
  assert.deepEqual(
    order([
      task({ title: "later", dueDate: "2026-10-25" }),
      task({ title: "earlier", dueDate: "2026-10-22" }),
    ]),
    ["earlier", "later"]
  );
});

test("tasks with no due date go last", () => {
  assert.deepEqual(
    order([task({ title: "undated" }), task({ title: "far", dueDate: "2027-01-01" })]),
    ["far", "undated"]
  );
});

test("same due date: higher priority first", () => {
  assert.deepEqual(
    order([
      task({ title: "medium", dueDate: "2026-10-22", priority: "medium" }),
      task({ title: "high", dueDate: "2026-10-22", priority: "high" }),
    ]),
    ["high", "medium"]
  );
});

test("same due date and priority: older task first", () => {
  assert.deepEqual(
    order([
      task({ title: "newer", dueDate: "2026-10-22", createdAt: "2026-10-02T00:00:00.000Z" }),
      task({ title: "older", dueDate: "2026-10-22", createdAt: "2026-10-01T00:00:00.000Z" }),
    ]),
    ["older", "newer"]
  );
});

test("a missing estimate is assumed to be 30 minutes and the plan says so", () => {
  const plan = buildPlan([task({ title: "no estimate" })], { date: DATE });
  assert.equal(DEFAULT_ESTIMATE_MINUTES, 30);
  assert.equal(plan.scheduled[0].minutes, 30);
  assert.equal(plan.scheduled[0].estimateAssumed, true);
  assert.ok(plan.notes.includes("1 task(s) have no time estimate, so 30 minutes each was assumed."));
  assert.ok(formatPlan(plan).includes("30 min (assumed)"));
});

test("an estimate that is given is used as is", () => {
  const plan = buildPlan([task({ title: "t", estimateMinutes: 45 })], { date: DATE });
  assert.equal(plan.scheduled[0].minutes, 45);
  assert.equal(plan.scheduled[0].estimateAssumed, false);
});

test("what does not fit is listed, and smaller later tasks can still fit", () => {
  const plan = buildPlan(
    [
      task({ title: "X", dueDate: "2026-10-22", estimateMinutes: 60 }),
      task({ title: "Y", dueDate: "2026-10-23", estimateMinutes: 60 }),
      task({ title: "Z", dueDate: "2026-10-24", estimateMinutes: 30 }),
    ],
    { date: DATE, availableMinutes: 100 }
  );
  assert.deepEqual(plan.scheduled.map((p) => p.task.title), ["X", "Z"]);
  assert.deepEqual(plan.unscheduled.map((p) => p.task.title), ["Y"]);
  assert.equal(plan.scheduledMinutes, 90);
  assert.equal(plan.totalMinutes, 150);
  assert.equal(plan.overloaded, true);
  assert.ok(
    plan.notes.some((n) => n.startsWith("Workload is 150 min but only 100 min are available."))
  );
  assert.ok(formatPlan(plan).includes("Does not fit in the time available:"));
});

test("a task that exactly fills the time still fits", () => {
  const plan = buildPlan([task({ title: "exact", estimateMinutes: 60 })], {
    date: DATE,
    availableMinutes: 60,
  });
  assert.equal(plan.scheduled.length, 1);
  assert.equal(plan.unscheduled.length, 0);
  assert.equal(plan.overloaded, false);
});

test("when everything fits, the day is not overloaded", () => {
  const plan = buildPlan(
    [task({ title: "a", estimateMinutes: 20 }), task({ title: "b", estimateMinutes: 30 })],
    { date: DATE, availableMinutes: 60 }
  );
  assert.equal(plan.overloaded, false);
  assert.equal(plan.unscheduled.length, 0);
});

test("with no available time given, nothing is dropped and the plan says it did not check", () => {
  const plan = buildPlan([task({ title: "a", estimateMinutes: 500 })], { date: DATE });
  assert.equal(plan.scheduled.length, 1);
  assert.equal(plan.overloaded, false);
  assert.ok(
    plan.notes.includes("No available time was given, so tasks are ordered but not checked against your day.")
  );
});

test("the plan always admits it cannot see a calendar", () => {
  const plan = buildPlan([task({ title: "a" })], { date: DATE });
  assert.ok(
    plan.notes.includes("Calendar events are not considered because no calendar is connected yet.")
  );
});

test("the written plan marks overdue tasks", () => {
  const text = formatPlan(buildPlan([task({ title: "late", dueDate: "2026-10-19" })], { date: DATE }));
  assert.ok(text.includes("due 2026-10-19, OVERDUE"));
});