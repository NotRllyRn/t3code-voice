import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";
import { Lifecycle } from "./lifecycle.js";

test("lifecycle stop is idempotent, invalidates identity, and isolates failing finalizers", async () => {
  const life = new Lifecycle();
  const session = life.begin("voice", "ws");
  let ran = 0;
  life.own(session, () => {
    throw Error("one cleanup failed");
  });
  life.own(session, () => {
    ran++;
  });
  await Promise.all([life.stop(), life.stop()]);
  NodeAssert.equal(ran, 1);
  NodeAssert.equal(life.alive(session), false);
  let completeCleanup = () => {};
  const lateCleanup = new Promise<void>((resolve) => {
    completeCleanup = resolve;
  });
  life.own(session, () => {
    ran++;
    completeCleanup();
  });
  await lateCleanup;
  NodeAssert.equal(ran, 2);
});
