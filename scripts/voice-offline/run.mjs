#!/usr/bin/env node
// Offline-only integration driver. No provider credential or production state is accepted.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { WebSocketServer } from "@effect/platform-node/NodeWS";
import { DEFAULT_MODEL } from "@t3tools/contracts";
import { assertTruncate } from "./accounting.mjs";

const { randomUUID } = NodeCrypto;
const assert = NodeAssert,
  path = NodePath;
const { spawn } = NodeChildProcess,
  { once } = NodeEvents;
const { mkdtemp, mkdir, writeFile, rm, access, copyFile } = NodeFSP;
const { createServer } = NodeNet,
  { tmpdir } = NodeOS;
const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const host = process.env.VOICE_BROWSER_HOST;
const browserNode = process.env.VOICE_BROWSER_NODE || "node";
const playwrightPath = process.env.VOICE_PLAYWRIGHT_PATH || "playwright";
const output = path.join(
  path.resolve(process.env.VOICE_OFFLINE_OUTPUT || path.join(tmpdir(), "t3voice-offline-evidence")),
  `run-${Date.now()}-${process.pid}`,
);
const interrupted = new AbortController();
const deadline = AbortSignal.any([AbortSignal.timeout(240_000), interrupted.signal]);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => interrupted.abort(new Error(`Harness received ${signal}`)));
const children = new Set();
const logs = [];
const pendingLogs = new Map();
let privateDir;
let remoteDir;
let runnerDir;
let ownedCleaned = false;
const ownerToken = randomUUID();
const timeoutProbe = process.env.VOICE_OFFLINE_TIMEOUT_PROBE === "1";
let mock;
const auth = "fictional-offline-development-auth-0000000000000000";
const sanitize = (text) =>
  String(text)
    .replaceAll(auth, "<app-auth>")
    .replace(/([?&#](?:wsTicket|token\w*|ticket\w*|auth\w*)=)[^\s&"']+/gi, "$1<app-auth>")
    .replaceAll(root.replace(/\/$/, ""), "<checkout>")
    .replaceAll(privateDir || "\0", "<disposable>")
    .replaceAll(remoteDir || "\0", "<browser-temp>")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "/<user>")
    .replace(/\/root(?=\/|\b)/g, "/<user>");
function record(label, chunk) {
  // Sanitize complete lines, not arbitrary stream chunks that can split an auth value.
  const lines = `${pendingLogs.get(label) || ""}${chunk}`.split("\n");
  pendingLogs.set(label, lines.pop());
  for (const line of lines) logs.push(`[${label}] ${sanitize(line)}`);
}
function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.add(child);
  child.stdout.on("data", (data) => record(label, data));
  child.stderr.on("data", (data) => record(label, data));
  child.on("error", (error) => record(label, error.stack));
  return child;
}
async function command(label, command, args, options = {}) {
  const child = start(label, command, args, options);
  let stdout = "",
    probeDeadline;
  child.stdout.on("data", (data) => {
    stdout += data;
    if (
      label === "browser" &&
      timeoutProbe &&
      !probeDeadline &&
      stdout.includes('"timeoutProbeReady":true')
    ) {
      probeDeadline = AbortSignal.timeout(1000);
      probeDeadline.addEventListener("abort", () => interrupted.abort(probeDeadline.reason), {
        once: true,
      });
    }
  });
  try {
    const [code, signal] = await once(child, "exit", {
      signal: label === "remote-cleanup" ? AbortSignal.timeout(15_000) : deadline,
    });
    assert.equal(code, 0, `${label} exited ${code}/${signal}; see run.log`);
    return stdout.trim();
  } finally {
    await stop(child);
  }
}
async function stop(child) {
  if (!children.delete(child) || !child.pid) return;
  // The captured group can still contain descendants after its wrapper has exited.
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!signal("SIGTERM")) return;
  const exited =
    child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
  const end = Date.now() + 5000;
  while (signal(0)) {
    if (Date.now() >= end) {
      signal("SIGKILL");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await exited;
}
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
function untilLog(child, pattern, label) {
  deadline.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${label}: readiness timeout`)), 90_000);
    const abort = () => finish(deadline.reason);
    deadline.addEventListener("abort", abort, { once: true });
    const check = (data) => {
      if (pattern.test(String(data))) finish();
    };
    const exited = (code) => finish(new Error(`${label}: exited before ready (${code})`));
    const finish = (error) => {
      clearTimeout(timer);
      deadline.removeEventListener("abort", abort);
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      child.off("exit", exited);
      if (error) reject(error);
      else resolve();
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", exited);
  });
}
// No inherited HOME, provider keys, .env files, NODE_OPTIONS, or auth directories.
function environment(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: path.join(home, "codex"),
    TMPDIR: privateDir,
    LANG: "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    T3CODE_DEV_SEED: "0",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    E2E_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: `--import=${new URL("./loopback-only.mjs", import.meta.url).href}`,
    T3CODE_RELAY_URL: "",
    VITE_T3CODE_RELAY_URL: "",
  };
}

async function run() {
  for (const directory of [".", "apps/web", "apps/server"]) {
    for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
      const name = path.join(directory, file);
      await access(path.join(root, name)).then(
        () => {
          throw new Error(`Offline harness refuses ${name}; use a clean checkout`);
        },
        (error) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    }
  }
  privateDir = await mkdtemp(path.join(tmpdir(), "t3-voice-offline-"));
  await mkdir(output, { recursive: true });
  const sourceSHA = await command("source", "git", ["rev-parse", "HEAD"]);
  const mockPort = await port(),
    appPort = await port(),
    webPort = await port();
  const origin = `http://127.0.0.1:${webPort}`;
  const stats = {
    allocations: 0,
    commits: 0,
    responses: 0,
    cancel: 0,
    truncate: 0,
    stale: 0,
    closed: 0,
  };
  const mockErrors = [],
    truncates = [];
  mock = new WebSocketServer({ host: "127.0.0.1", port: mockPort });
  await once(mock, "listening");
  mock.on("connection", (socket, request) => {
    if (request.headers.authorization !== "Bearer fictional-offline-key") {
      mockErrors.push("Mock received unexpected authorization");
      socket.close(1008);
      return;
    }
    const allocation = ++stats.allocations;
    let turn = 0,
      response,
      item;
    const send = (value) => socket.send(JSON.stringify(value));
    const audio = () => ({
      type: "response.output_audio.delta",
      response_id: response,
      item_id: item,
      content_index: 0,
      delta: Buffer.alloc(24_000).toString("base64"),
    });
    socket.on("close", () => stats.closed++);
    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(String(raw));
        if (event.type === "session.update") {
          assert.deepEqual(event.session.tools, []);
          if (allocation % 2 === 1)
            send({
              type: "error",
              error: { code: "invalid_value", message: "fictional mock rejection" },
            });
          else send({ type: "session.updated" });
        } else if (event.type === "input_audio_buffer.commit") {
          stats.commits++;
          send({
            type: "input_audio_buffer.committed",
            item_id: `input-${allocation}-${turn + 1}`,
          });
        } else if (event.type === "response.create") {
          stats.responses++;
          turn++;
          response = `response-${allocation}-${turn}`;
          item = `audio-${allocation}-${turn}`;
          send({
            type: "response.created",
            response: { id: response, metadata: event.response.metadata },
          });
          send({
            type: "response.content_part.added",
            response_id: response,
            item_id: item,
            content_index: 0,
            part: { type: "audio" },
          });
          send(audio());
        } else if (event.type === "response.cancel") {
          stats.cancel++;
          assert.equal(event.response_id, response);
          send({ type: "response.done", response: { id: response, status: "cancelled" } });
        } else if (event.type === "conversation.item.truncate") {
          assert.equal(event.item_id, item, "Mock truncate item identity");
          assert.equal(event.content_index, 0, "Mock truncate content identity");
          assert.ok(
            Number.isInteger(event.audio_end_ms) &&
              event.audio_end_ms >= 0 &&
              event.audio_end_ms <= 500,
          );
          truncates.push(event);
          stats.truncate++;
          // The browser records the matching flush ACK before forwarding this truncate.
          stats.stale++;
          send(audio());
        } else
          assert.ok(
            ["input_audio_buffer.append", "input_audio_buffer.clear"].includes(event.type),
            `unexpected mock event: ${event.type}`,
          );
      } catch (error) {
        mockErrors.push(error.message);
        record("mock", error.stack);
        socket.close(1011);
      }
    });
  });
  const evidence = {
    sourceSHA,
    model: DEFAULT_MODEL,
    offline: true,
    runtime: { node: process.version },
    runs: [],
    mock: stats,
  };
  if (host) {
    assert.match(host, /^[a-zA-Z0-9_.@-]+$/, "SSH host must be an alias, not options");
    const created = await command("remote-temp", "ssh", [
      host,
      "mktemp -d /tmp/t3-voice-offline.XXXXXXXX",
    ]);
    assert.match(created, /^\/tmp\/t3-voice-offline\.[a-zA-Z0-9]+$/);
    remoteDir = created;
    runnerDir = remoteDir;
    await command("copy-browser", "scp", [
      ...["browser.mjs", "owned-browser.mjs", "accounting.mjs"].map((file) =>
        path.join(root, "scripts/voice-offline", file),
      ),
      `${host}:${remoteDir}/`,
    ]);
    const tunnel = start("tunnel", "ssh", [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-R",
      `127.0.0.1:${webPort}:127.0.0.1:${webPort}`,
      host,
    ]);
    // Browser fetch readiness below also verifies the tunnel, without arbitrary startup sleeps.
    assert.ok(tunnel.pid);
  } else {
    runnerDir = path.join(privateDir, "browser");
    await mkdir(runnerDir);
    for (const file of ["browser.mjs", "owned-browser.mjs", "accounting.mjs"])
      await copyFile(path.join(root, "scripts/voice-offline", file), path.join(runnerDir, file));
  }
  for (let index = 1; index <= 2; index++) {
    const state = path.join(privateDir, `run-${index}`),
      home = path.join(state, "home");
    await mkdir(path.join(state, "userdata"), { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(path.join(state, "workspace"));
    const providers = Object.fromEntries(
      ["codex", "claudeAgent", "cursor", "grok", "muse", "pi", "opencode", "antigravity"].map(
        (driver) => [driver, { driver, enabled: false }],
      ),
    );
    providers.codex = {
      driver: "codex",
      enabled: true,
      config: {
        setupMode: "existing",
        binaryPath: path.join(state, "codex-does-not-exist"),
        homePath: path.join(home, "codex"),
        customModels: [DEFAULT_MODEL],
      },
    };
    await writeFile(
      path.join(state, "userdata/settings.json"),
      JSON.stringify({ providerInstances: providers }),
    );
    const key = path.join(state, "fictional-key");
    await writeFile(key, "fictional-offline-key\n", { mode: 0o600 });
    const env = {
      ...environment(home),
      T3CODE_PORT: String(appPort),
      T3CODE_DEV_AUTH_TOKEN: auth,
      T3CODE_DEV_ALLOWED_ORIGINS: origin,
      T3CODE_REALTIME_URL: `ws://127.0.0.1:${mockPort}/realtime?model=fictional`,
      T3CODE_REALTIME_API_KEY_FILE: key,
    };
    const server = start(
      "server",
      process.execPath,
      [
        "apps/server/src/bin.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(appPort),
        "--base-dir",
        state,
        "--dev-url",
        origin,
        "--no-browser",
      ],
      { env },
    );
    await untilLog(
      server,
      /(?:server started|listening|Server ready|http:\/\/127\.0\.0\.1)/i,
      "app server",
    );
    const web = start(
      "vite",
      path.join(root, "node_modules/.bin/vp"),
      ["dev", "--host", "127.0.0.1", "--port", String(webPort)],
      {
        cwd: path.join(root, "apps/web"),
        env: { ...env, PORT: String(webPort), HOST: "127.0.0.1", T3CODE_SINGLE_ORIGIN_DEV: "1" },
      },
    );
    await untilLog(web, /Local:|ready in/, "Vite");
    const config = Buffer.from(
      JSON.stringify({
        origin,
        auth,
        model: DEFAULT_MODEL,
        workspace: path.join(state, "workspace"),
        playwrightPath,
        ownerToken,
        timeoutProbe,
      }),
    ).toString("base64");
    const browserArgs = [`${runnerDir}/owned-browser.mjs`, config];
    const browserOutput = host
      ? await command("browser", "ssh", [
          host,
          [browserNode, ...browserArgs].map(shellQuote).join(" "),
        ])
      : await command("browser", browserNode, browserArgs);
    const result = JSON.parse(
      browserOutput.split("\n").findLast((line) => line.startsWith('{"passed"')),
    );
    assert.equal(truncates.length, index * 2);
    result.truncates = truncates.slice((index - 1) * 2, index * 2);
    result.metrics.interruptions.forEach((flush, offset) =>
      assertTruncate(result.truncates[offset], flush),
    );
    evidence.runs.push(result);
    await stop(web);
    await stop(server);
    // The next run receives a new DB, HOME, credentials, and browser context.
    await rm(state, { recursive: true, force: true });
    await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  }
  assert.equal(stats.allocations, 4);
  assert.equal(stats.commits, 4);
  assert.equal(stats.responses, 4);
  assert.equal(stats.cancel, 4);
  assert.equal(stats.truncate, 4);
  assert.equal(stats.stale, 4);
  assert.equal(stats.closed, 4);
  assert.deepEqual(mockErrors, []);
  // The app logger prints one finite object per failure; no raw mock message is allowed.
  const diagnostics = [
    ...logs.join("\n").matchAll(/Voice relay failed\s*(?:\[server\]\s*)?\{([^}]+)\}/g),
  ].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/(\w+): ('[^']*'|true|false|\d+)/g)].map(([, key, value]) => [
        key,
        value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value),
      ]),
    ),
  );
  const diagnostic = {
    upstreamFailureEvent: "error",
    upstreamErrorCode: "invalid_value",
    lastClientEvent: "none",
    lastServerEvent: "none",
    responsePending: false,
    responseGenerating: false,
    responsesCreated: 0,
    responsesDone: 0,
    cancelRequests: 0,
    cancelWithoutObservedActiveResponse: 0,
    truncateRequests: 0,
  };
  assert.equal(diagnostics.length, 4, "one mock failure plus one explicit-stop diagnostic per run");
  for (const [index, value] of diagnostics.entries())
    assert.deepEqual(
      value,
      index % 2 === 0
        ? diagnostic
        : {
            ...diagnostic,
            upstreamFailureEvent: "none",
            upstreamErrorCode: "none",
            lastClientEvent: "conversation.item.truncate",
            lastServerEvent: "response.output_audio.delta",
            responsesCreated: 2,
            responsesDone: 2,
            cancelRequests: 2,
            truncateRequests: 2,
          },
    );
  evidence.diagnostics = diagnostics;
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS: two fresh offline runs; evidence: ${output}`);
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
let failed;
try {
  await run();
} catch (error) {
  failed = error;
  record("failure", error.stack);
} finally {
  if (runnerDir) {
    try {
      const args = [`${runnerDir}/owned-browser.mjs`, "--stop", ownerToken];
      const cleanup = host
        ? await command("remote-cleanup", "ssh", [
            host,
            [browserNode, ...args].map(shellQuote).join(" "),
          ])
        : await command("remote-cleanup", browserNode, args);
      record("owned-cleanup", cleanup);
      ownedCleaned = true;
    } catch (error) {
      record("cleanup", error.stack);
      failed ||= error;
    }
  }
  for (const child of [...children].reverse()) {
    try {
      await stop(child);
    } catch (error) {
      record("cleanup", error.stack);
      failed ||= error;
    }
  }
  if (mock) {
    for (const client of mock.clients) client.terminate();
    await new Promise((resolve) => mock.close(resolve));
  }
  if (remoteDir && ownedCleaned) {
    try {
      await command("remote-cleanup", "ssh", [host, `rm -rf ${shellQuote(remoteDir)}`]);
    } catch (error) {
      failed ||= error;
    }
  }
  if (privateDir) await rm(privateDir, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const [label, line] of pendingLogs) if (line) logs.push(`[${label}] ${line}`);
  await writeFile(path.join(output, "run.log"), sanitize(logs.join("\n")), { mode: 0o600 });
}
if (failed) {
  console.error(sanitize(failed.stack));
  console.error(`Details: ${output}/run.log`);
  process.exitCode = 1;
}
