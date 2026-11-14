// The browser host owns both child handles. SSH transport death is not a cleanup signal.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const assert = NodeAssert,
  fs = NodeFSP;
const { spawn } = NodeChildProcess,
  { once } = NodeEvents;
const { createServer, createConnection } = NodeNet,
  { createRequire } = NodeModule;
const { dirname, join } = NodePath,
  { fileURLToPath } = NodeURL;
// Losing the SSH reader must not bypass the owner's watchdog/teardown.
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });
const directory = dirname(fileURLToPath(import.meta.url));
const socketPath = join(directory, "owner.sock");
const ownerPath = join(directory, "owner.json");
const donePath = join(directory, "done.json");

if (process.argv[2] === "--stop") {
  const token = process.argv[3];
  const owner = JSON.parse(
    await fs.readFile(ownerPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "null";
      throw error;
    }),
  );
  if (owner) {
    assert.equal(owner.token, token, "Remote ownership token mismatch");
    const done = await fs.readFile(donePath, "utf8").then(JSON.parse, () => null);
    if (!done) {
      await new Promise((resolve, reject) => {
        const socket = createConnection(socketPath);
        const timer = setTimeout(
          () => socket.destroy(Error("Owned browser cleanup timed out")),
          12_000,
        );
        let reply = "";
        socket.on("connect", () => socket.end(`${token}\n`));
        socket.on("data", (data) => {
          reply += data;
        });
        socket.on("error", reject);
        socket.on("close", () => {
          clearTimeout(timer);
          if (reply.trim() === "stopped") resolve();
          else reject(Error("Owned browser did not confirm cleanup"));
        });
      });
    }
    const result = JSON.parse(await fs.readFile(donePath, "utf8"));
    assert.equal(result.token, token);
    assert.equal(result.childrenExited, true);
    const { token: _token, ...facts } = result;
    console.log(JSON.stringify({ ownedCleanup: true, ...facts }));
  }
} else {
  const config = JSON.parse(Buffer.from(process.argv[2], "base64").toString());
  const token = config.ownerToken;
  assert.match(token, /^[a-f0-9-]{36}$/);
  await fs.rm(donePath, { force: true });
  await fs.rm(socketPath, { force: true });
  assert.ok(
    config.ownerTimeoutMs === undefined ||
      (Number.isInteger(config.ownerTimeoutMs) &&
        config.ownerTimeoutMs > 0 &&
        config.ownerTimeoutMs <= 240_000),
  );
  let driver, server, launching, stopping;
  let driverExit;
  const initialized = Promise.withResolvers();
  const owner = { token, pid: process.pid };
  const stop = (reason) =>
    (stopping ??= (async () => {
      // Startup must either register its launch promise or rule out creating children.
      await initialized.promise;
      if (driver && driver.exitCode === null && driver.signalCode === null) driver.kill("SIGTERM");
      // launchServer retains the actual Chromium child handle and kills its owned process group.
      const launched = await launching?.catch(() => null);
      await launched?.kill();
      if (driverExit) {
        const force = setTimeout(() => {
          if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
        }, 3000);
        try {
          await driverExit;
        } finally {
          clearTimeout(force);
        }
      }
      await fs.writeFile(donePath, JSON.stringify({ ...owner, reason, childrenExited: true }), {
        mode: 0o600,
      });
      clearTimeout(watchdog);
      control.close();
      if (reason !== "completed") process.exitCode = 1;
    })());
  const control = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (data) => {
      request += data;
      if (request.length > 100) socket.destroy();
    });
    socket.on("end", () => {
      if (request.trim() !== token) return socket.end("refused\n");
      void stop("explicit-cleanup").then(
        () => socket.end("stopped\n"),
        (error) => socket.destroy(error),
      );
    });
    socket.on("error", () => {});
  });
  const watchdog = setTimeout(() => void stop("watchdog"), config.ownerTimeoutMs || 240_000);
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"])
    process.once(signal, () => void stop(signal));
  try {
    try {
      control.listen(socketPath);
      await once(control, "listening");
      await fs.writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
      if (stopping) throw Error("Owned browser stopped before launch");
      const { chromium } = createRequire(import.meta.url)(config.playwrightPath);
      launching = chromium.launchServer({
        host: "127.0.0.1",
        headless: true,
        chromiumSandbox: true,
        args: ["--autoplay-policy=no-user-gesture-required"],
      });
    } finally {
      initialized.resolve();
    }
    server = await launching;
    if (stopping) throw Error("Owned browser stopped during launch");
    owner.browserPid = server.process().pid;
    driver = spawn(
      process.execPath,
      [
        join(directory, "browser.mjs"),
        Buffer.from(JSON.stringify({ ...config, browserEndpoint: server.wsEndpoint() })).toString(
          "base64",
        ),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    owner.driverPid = driver.pid;
    driverExit = once(driver, "close");
    driver.stdout.pipe(process.stdout);
    driver.stderr.pipe(process.stderr);
    await fs.writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600 });
    const [code] = await driverExit;
    if (code !== 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await stop("completed");
  }
}
