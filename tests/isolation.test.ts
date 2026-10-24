import { test, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db.js";
import { addTask, completeTask, deleteTask, getTask, listTasks, updateTask } from "../src/tasks.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const stamp = `isotest-${Date.now()}`;
const createdUserIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: { googleId: `${stamp}-${label}`, email: `${stamp}-${label}@example.test` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

after(async () => {
  if (!hasDb) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

test("each user only sees their own tasks", { skip: !hasDb }, async () => {
  const a = await makeUser("a");
  const b = await makeUser("b");
  await addTask(a, { title: "A task" });
  await addTask(b, { title: "B task" });
  assert.deepEqual((await listTasks(a)).map((t) => t.title), ["A task"]);
  assert.deepEqual((await listTasks(b)).map((t) => t.title), ["B task"]);
});

test("another user cannot read, change, finish, or delete a task", { skip: !hasDb }, async () => {
  const owner = await makeUser("owner");
  const intruder = await makeUser("intruder");
  const task = await addTask(owner, { title: "Private", priority: "high" });

  assert.equal(await getTask(intruder, task.id), null);
  assert.equal(await updateTask(intruder, task.id, { title: "Hacked" }), null);
  assert.equal(await completeTask(intruder, task.id), null);
  assert.equal(await deleteTask(intruder, task.id), false);

  const still = await getTask(owner, task.id);
  assert.equal(still?.title, "Private");
  assert.equal(still?.priority, "high");
  assert.equal(still?.done, false);
});

test("deleting a user removes their tasks", { skip: !hasDb }, async () => {
  const user = await makeUser("leaver");
  const task = await addTask(user, { title: "Goes away" });
  await prisma.user.delete({ where: { id: user } });
  assert.equal(await prisma.task.count({ where: { id: task.id } }), 0);
});

test("a task with no owner is invisible to everyone", { skip: !hasDb }, async () => {
  const user = await makeUser("viewer");
  const orphan = await prisma.task.create({ data: { title: "Orphan" } });
  try {
    assert.equal(await getTask(user, orphan.id), null);
    assert.equal((await listTasks(user)).length, 0);
  } finally {
    await prisma.task.delete({ where: { id: orphan.id } });
  }
});