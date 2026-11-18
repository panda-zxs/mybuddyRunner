import test from "node:test";
import assert from "node:assert/strict";
import { assertTaskActive, checkTaskState } from "./task-state.mjs";

const config = { serverURL: "https://updates.example", taskId: "bt_0102030405060708090a0b0c", secret: "fixture-secret" };

test("active task states including dispatch acknowledgement races may start work", () => {
  for (const status of ["pending", "dispatching", "dispatched", "running", null]) assert.doesNotThrow(() => assertTaskActive(config.taskId, status));
  for (const status of ["failed", "succeeded", "canceled", "unexpected-secret"]) {
    assert.throws(() => assertTaskActive(config.taskId, status), error => /cannot accept uploads/.test(error.message) && !error.message.includes("unexpected-secret"));
  }
});

test("the task check validates identity and authentication without following redirects", async () => {
  const status = await checkTaskState(config, async (url, options) => {
    assert.equal(url.href, `https://updates.example/releases/ci/v1/tasks/${config.taskId}/plan`);
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    assert.equal(options.redirect, "error");
    return Response.json({ taskId: config.taskId }, { headers: { "X-MyBuddy-Task-Status": "running" } });
  });
  assert.equal(status, "running");
  for (const body of [null, {}, { taskId: "other" }]) await assert.rejects(checkTaskState(config, async () => Response.json(body)), /identity mismatch/);
  await assert.rejects(checkTaskState(config, async () => new Response("fixture-secret", { status: 403 })), error => error.message === "task state check failed (403)");
  for (const changes of [{ serverURL: "http://updates.example" }, { serverURL: "https://user:password@updates.example" }, { taskId: "../../other" }, { secret: "" }]) {
    await assert.rejects(checkTaskState({ ...config, ...changes }, async () => assert.fail("credentials must not be sent")), /invalid task state configuration/);
  }
});
