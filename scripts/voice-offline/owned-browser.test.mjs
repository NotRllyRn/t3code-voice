import * as NodeAssert from "node:assert/strict";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
const assert = NodeAssert;
const { test } = NodeTest;

const deferred = () => Promise.withResolvers();
// All IO is gated or synchronous; this checkpoint drains only runnable promise continuations.
const checkpoint = () => new Promise(setImmediate);

async function startOwner() {
  const initialization = deferred();
  const writingOwner = deferred();
  const launching = deferred();
  const launchStarted = deferred();
  const killing = deferred();
  const killStarted = deferred();
  const driverStarted = deferred();
  const calls = [];
  const timers = new Set();
  const process = new NodeEvents.EventEmitter();
  process.pid = 100;
  process.stdout = new NodeStream.PassThrough();
  process.stderr = new NodeStream.PassThrough();
  const token = "00000000-0000-0000-0000-000000000000";
  process.argv = [
    "node",
    "owned-browser.mjs",
    Buffer.from(JSON.stringify({ ownerToken: token })).toString("base64"),
  ];
  const control = new NodeEvents.EventEmitter();
  control.listen = () => queueMicrotask(() => control.emit("listening"));
  control.close = () => calls.push("control-close");
  let done;
  let resources = 0;
  const browser = {
    process: () => ({ pid: 101 }),
    wsEndpoint: () => "ws://fictional-browser",
    kill: async () => {
      calls.push("kill");
      killStarted.resolve();
      await killing.promise;
      resources--;
    },
  };
  const driver = new NodeEvents.EventEmitter();
  Object.assign(driver, {
    pid: 102,
    exitCode: null,
    signalCode: null,
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: (signal) => calls.push(signal),
  });
  const context = NodeVM.createContext({
    process,
    Buffer,
    console: { error: () => {} },
    setTimeout: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimeout: (timer) => timers.delete(timer),
  });
  const source = await NodeFSP.readFile(new URL("./owned-browser.mjs", import.meta.url), "utf8");
  const module = new NodeVM.SourceTextModule(source, {
    context,
    initializeImportMeta: (meta) => {
      meta.url = new URL("./owned-browser.mjs", import.meta.url).href;
    },
  });
  const bindings = {
    "node:assert/strict": NodeAssert,
    "node:events": NodeEvents,
    "node:path": NodePath,
    "node:url": NodeURL,
    "node:fs/promises": {
      rm: async () => {},
      writeFile: async (path, data) => {
        if (path.endsWith("done.json")) {
          calls.push("done");
          done = JSON.parse(data);
        } else if (!calls.includes("owner-write")) {
          calls.push("owner-write");
          writingOwner.resolve();
          await initialization.promise;
        }
      },
    },
    "node:net": {
      createServer: (_options, accept) => {
        control.accept = accept;
        return control;
      },
    },
    "node:module": {
      createRequire: () => () => ({
        chromium: {
          launchServer: () => {
            calls.push("launch");
            resources++;
            launchStarted.resolve();
            return launching.promise;
          },
        },
      }),
    },
    "node:child_process": {
      spawn: () => {
        calls.push("spawn");
        driverStarted.resolve();
        return driver;
      },
    },
  };
  await module.link((specifier) => {
    const exports = bindings[specifier];
    assert.ok(exports, specifier);
    return new NodeVM.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      },
      { context },
    );
  });
  const finished = module.evaluate();
  await writingOwner.promise;
  return {
    calls,
    timers,
    initialization,
    launchStarted,
    killStarted,
    killing,
    driverStarted,
    driver,
    finished,
    process,
    get done() {
      return done;
    },
    get resources() {
      return resources;
    },
    releaseLaunch: () => launching.resolve(browser),
    stop: () => {
      const reply = deferred();
      const socket = new NodeEvents.EventEmitter();
      socket.setEncoding = () => {};
      socket.end = (message) => reply.resolve(message);
      socket.destroy = (error) => reply.reject(error);
      control.accept(socket);
      socket.emit("data", `${token}\n`);
      socket.emit("end");
      return reply.promise;
    },
  };
}

for (const phase of ["initialization", "launch"]) {
  test(`stop during ${phase} waits for startup and owned child exit`, async () => {
    const owner = await startOwner();
    if (phase === "launch") {
      owner.initialization.resolve();
      await owner.launchStarted.promise;
    }
    let reply;
    const stopped = owner.stop().then((value) => {
      reply = value;
    });
    await checkpoint();
    assert.equal(reply, undefined, "stop must not acknowledge pending startup");
    assert.equal(owner.done, undefined, "no premature childrenExited record");
    assert.equal(owner.timers.size, 1, "watchdog remains armed during startup");
    if (phase === "initialization") {
      owner.initialization.resolve();
    } else {
      owner.releaseLaunch();
      await owner.killStarted.promise;
      await checkpoint();
      assert.equal(reply, undefined, "stop must wait for the late child's kill");
      assert.equal(owner.done, undefined);
      assert.equal(owner.resources, 1);
      assert.equal(owner.timers.size, 1);
      owner.killing.resolve();
    }
    await stopped;
    await owner.finished;
    assert.equal(reply, "stopped\n");
    assert.equal(owner.done.childrenExited, true);
    assert.equal(owner.done.reason, "explicit-cleanup");
    assert.equal(owner.process.exitCode, 1);
    assert.equal(owner.resources, 0);
    assert.equal(owner.timers.size, 0);
    assert.deepEqual(
      owner.calls,
      phase === "initialization"
        ? ["owner-write", "done", "control-close"]
        : ["owner-write", "launch", "kill", "done", "control-close"],
    );
  });
}

test("healthy driver completion kills the browser before recording success", async () => {
  const owner = await startOwner();
  owner.initialization.resolve();
  await owner.launchStarted.promise;
  owner.releaseLaunch();
  await owner.driverStarted.promise;
  owner.driver.exitCode = 0;
  owner.driver.emit("close", 0);
  await owner.killStarted.promise;
  assert.equal(owner.done, undefined);
  assert.equal(owner.timers.size, 1);
  owner.killing.resolve();
  await owner.finished;
  assert.equal(owner.process.exitCode, undefined);
  assert.equal(owner.done.reason, "completed");
  assert.equal(owner.done.childrenExited, true);
  assert.equal(owner.resources, 0);
  assert.equal(owner.timers.size, 0);
  assert.deepEqual(owner.calls, [
    "owner-write",
    "launch",
    "spawn",
    "kill",
    "done",
    "control-close",
  ]);
});
