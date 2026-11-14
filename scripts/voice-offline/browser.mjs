// Copied unchanged to the browser host. Uses its existing Playwright/Chromium, never installs.
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import { createPlaybackLedger } from "./accounting.mjs";
const config = JSON.parse(Buffer.from(process.argv[2], "base64").toString());
const { chromium } = NodeModule.createRequire(import.meta.url)(config.playwrightPath);
let browser, context, page;
let closing;
const close = () =>
  (closing ??= (async () => {
    if (page)
      await page
        .evaluate(async () => {
          const synthetic = window.__voiceSynthetic;
          if (synthetic) {
            try {
              synthetic.oscillator.stop();
            } catch {}
            synthetic.gain.disconnect();
            await synthetic.source.close();
          }
        })
        .catch(() => {});
    await context?.close();
    await browser?.close();
  })());
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"])
  process.once(signal, () => {
    console.error(`Browser harness received ${signal}`);
    setTimeout(() => process.exit(1), 5000).unref();
    void close().finally(() => process.exit(1));
  });
const errors = [];
try {
  browser = await chromium.connect(config.browserEndpoint);
  context = await browser.newContext();
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient");
  });
  const instrument = () => {
    const ledger = window.__voiceLedger;
    const metrics = (window.__voiceOffline = {
      sockets: 0,
      opened: 0,
      closed: 0,
      ready: 0,
      errors: 0,
      commits: 0,
      appends: 0,
      stale: 0,
      stalePlayback: 0,
      worklets: 0,
      captureSamples: 0,
      playbackChunks: 0,
      playbackSamples: 0,
      progressSamples: 0,
      flushes: 0,
      flushed: 0,
    });
    const streams = [],
      contexts = [],
      ports = [];
    let cut = false,
      identity;
    const interruptions = (window.__voiceInterruptions = []);
    window.__voiceResources = { streams, contexts, ports };
    // Synthetic input only. The application's own AudioContext and AudioWorklet are real.
    const NativeContext = window.AudioContext;
    navigator.mediaDevices.getUserMedia = async () => {
      const source = new NativeContext();
      const oscillator = source.createOscillator();
      oscillator.frequency.value = 220;
      const gain = source.createGain();
      gain.gain.value = 0.04;
      const destination = source.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      await source.resume();
      streams.push(destination.stream);
      window.__voiceSynthetic = { source, oscillator, gain };
      return destination.stream;
    };
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args);
        contexts.push(this);
      }
    };
    const NativeWorklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeWorklet {
      constructor(...args) {
        super(...args);
        metrics.worklets++;
        const nodeId = metrics.worklets;
        let epoch = 0;
        const port = this.port;
        ports.push({ closed: false });
        const lease = ports.at(-1),
          close = port.close.bind(port);
        port.close = () => {
          lease.closed = true;
          return close();
        };
        const post = port.postMessage.bind(port);
        port.postMessage = (...values) => {
          const event = values[0];
          if (event.type === "audio") {
            metrics.playbackChunks++;
            metrics.playbackSamples += event.samples.length;
            ledger.enqueue(nodeId, event.epoch, event.samples.length, identity);
            if (cut) metrics.stalePlayback++;
          }
          if (event.type === "flush") {
            metrics.flushes++;
            ledger.flush(
              nodeId,
              epoch,
              event,
              Math.ceil(((args[0].baseLatency || 0) + (args[0].outputLatency || 0)) * 24000),
              args[0].sampleRate,
            );
            epoch = event.epoch;
          }
          return post(...values);
        };
        port.addEventListener("message", ({ data }) => {
          if (data.type === "capture") metrics.captureSamples += data.samples.length;
          if (data.type === "progress") ledger.progress(nodeId, data.epoch, data.played);
          if (data.type === "flushed") {
            metrics.flushed++;
            ledger.flushed(nodeId, data);
          }
          metrics.progressSamples = ledger.snapshot().progressSamples;
        });
        port.start();
      }
    };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        if (new URL(String(args[0])).pathname !== "/api/voice/realtime") return;
        metrics.sockets++;
        this.addEventListener("open", () => metrics.opened++);
        this.addEventListener("close", () => metrics.closed++);
        this.addEventListener("message", ({ data }) => {
          const event = JSON.parse(data);
          if (event.type === "relay.ready") metrics.ready++;
          if (event.type === "relay.error") metrics.errors++;
          if (event.type === "response.created") cut = false;
          if (event.type === "response.output_audio.delta") {
            if (cut) metrics.stale++;
            else identity = { item_id: event.item_id, content_index: event.content_index };
          }
        });
        const send = this.send.bind(this);
        this.send = (data) => {
          const event = JSON.parse(data);
          if (event.type === "input_audio_buffer.append") metrics.appends++;
          if (event.type === "input_audio_buffer.commit") metrics.commits++;
          if (event.type === "response.cancel") cut = true;
          if (event.type === "conversation.item.truncate") {
            const flush = ledger.flushes.findLast((fact) => fact.itemId === event.item_id);
            if (!flush || flush.played === undefined)
              throw Error("Truncate preceded its interruption flush acknowledgement");
            if (interruptions.some((fact) => fact.node === flush.node && fact.id === flush.id))
              throw Error("Interruption flush reused");
            interruptions.push({ ...flush });
          }
          return send(data);
        };
      }
    };
  };
  await context.addInitScript({
    content: `window.__voiceLedger = (${createPlaybackLedger.toString()})();(${instrument.toString()})();`,
  });
  page = await context.newPage();
  if (config.timeoutProbe) {
    console.log(JSON.stringify({ timeoutProbeReady: true }));
    await new Promise(() => {});
  }
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.goto(`${config.origin}/pair#token=${config.auth}`, { timeout: 90_000 });
  await page.waitForURL((url) => url.pathname !== "/pair", { timeout: 60_000 });
  // PairRoute replaces history then reloads to acquire the new cookie. Complete the normal
  // fresh-state welcome screen; do not confuse its history change with a mounted chat app.
  await page.getByRole("button", { name: "Start", exact: true }).click({ timeout: 60_000 });
  await page.getByRole("link", { name: "T3 Code home", exact: true }).waitFor({ timeout: 60_000 });
  const fixture = await page.evaluate(async ({ model, workspace }) => {
    const [
      { appAtomRegistry: registry },
      { primaryEnvironmentIdAtom },
      { serverEnvironment },
      { projectEnvironment },
      { orchestrationEnvironment },
    ] = await Promise.all([
      import("/src/rpc/atomRegistry.ts"),
      import("/src/state/primaryEnvironment.ts"),
      import("/src/state/server.ts"),
      import("/src/state/projects.ts"),
      import("/src/state/orchestration.ts"),
    ]);
    // subscribe mounts and retains the atom. Read only AFTER mounting; a plain get does not
    // start its stream. Keep both mounts until the model and command sequence is complete.
    const releases = [];
    const mounted = (atom, accepts, label) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture timed out: ${label}`)), 30_000);
        const check = (value) => {
          if (accepts(value)) {
            clearTimeout(timer);
            resolve(value);
          }
        };
        releases.push(registry.subscribe(atom, check));
        check(registry.get(atom));
      });
    const command = async (api, target, label) => {
      const result = await api.run(registry, target);
      if (result._tag !== "Success") throw new Error(`${label}: ${JSON.stringify(result)}`);
      return result.value;
    };
    try {
      const environmentId = await mounted(
        primaryEnvironmentIdAtom,
        (value) => typeof value === "string" && value.length > 0,
        "primary environment",
      );
      const advertised = await mounted(
        serverEnvironment.configValueAtom(environmentId),
        (value) => value !== null,
        "server config",
      );
      const provider = advertised.providers.find((entry) => entry.instanceId === "codex");
      if (!provider || provider.models.length !== 1 || provider.models[0].slug !== model)
        throw new Error(
          `Expected exactly the shipped model ${model}; advertised: ${JSON.stringify(provider?.models)}`,
        );
      const projectId = crypto.randomUUID(),
        threadId = crypto.randomUUID();
      const modelSelection = { instanceId: "codex", model };
      await command(
        projectEnvironment.create,
        {
          environmentId,
          input: {
            projectId,
            title: "Offline voice fixture",
            workspaceRoot: workspace,
            defaultModelSelection: modelSelection,
          },
        },
        "project.create",
      );
      await command(
        orchestrationEnvironment.v2.dispatchCommand,
        {
          environmentId,
          input: {
            type: "thread.create",
            commandId: crypto.randomUUID(),
            threadId,
            projectId,
            title: "Offline voice thread",
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          },
        },
        "thread.create",
      );
      return { environmentId, threadId, advertisedModels: provider.models.length };
    } finally {
      for (const release of releases.reverse()) release();
    }
  }, config);
  // Use the application's real accessible sidebar row: SPA navigation, not a reload race.
  await page.getByRole("button", { name: /Offline voice thread/ }).click();
  await page.waitForURL(`**/${fixture.environmentId}/${fixture.threadId}`);
  await page.getByRole("button", { name: "Voice conversation", exact: true }).click();
  const panel = page.getByRole("region", { name: "Separate voice conversation" });
  const clickEnabled = async (name) => {
    const button = panel.getByRole("button", { name, exact: true });
    await button.waitFor({ state: "visible" });
    await button.click(); // Playwright waits for enabled and actionable.
  };
  await clickEnabled("Start voice");
  await page.waitForFunction(
    () => window.__voiceOffline.errors === 1 && window.__voiceOffline.closed === 1,
  );
  await panel.getByRole("status").filter({ hasText: "Voice: error" }).waitFor();
  // Failed allocation can create media before it reaches the mock; prove that release too.
  await page.waitForFunction(
    () =>
      window.__voiceResources.contexts.every((item) => item.state === "closed") &&
      window.__voiceResources.streams.every((stream) =>
        stream.getTracks().every((track) => track.readyState === "ended"),
      ),
  );
  await page.evaluate(async () => {
    const { source, oscillator, gain } = window.__voiceSynthetic;
    oscillator.stop();
    gain.disconnect();
    await source.close();
  });
  await clickEnabled("Start voice");
  await panel.getByRole("status").filter({ hasText: "Voice: active" }).waitFor();
  for (let turn = 1; turn <= 2; turn++) {
    const before = await page.evaluate(() => window.__voiceOffline.appends);
    await clickEnabled("Record turn");
    // Capture enough actual 24kHz worklet PCM for the server's minimum turn budget.
    await page.waitForFunction((count) => window.__voiceOffline.appends >= count + 4, before);
    await clickEnabled("Send voice turn");
    await page.waitForFunction((turn) => {
      const rows = window.__voiceLedger.epochs.filter((row) => row.enqueued > 0);
      return rows.length === turn && rows.at(-1).enqueued === 12000 && rows.at(-1).progress > 0;
    }, turn);
    await clickEnabled("Interrupt voice");
    await page.waitForFunction((count) => window.__voiceOffline.stale === count, turn);
    NodeAssert.equal(await page.evaluate(() => window.__voiceOffline.stalePlayback), 0);
  }
  await clickEnabled("Stop voice");
  await panel.getByRole("status").filter({ hasText: "Voice: idle" }).waitFor();
  await page.waitForFunction(
    () =>
      window.__voiceOffline.closed === 2 &&
      window.__voiceResources.contexts.every((item) => item.state === "closed") &&
      window.__voiceResources.ports.every((port) => port.closed) &&
      window.__voiceResources.streams.every((stream) =>
        stream.getTracks().every((track) => track.readyState === "ended"),
      ),
  );
  const metrics = await page.evaluate(() => ({
    ...window.__voiceOffline,
    ...window.__voiceLedger.snapshot(),
    interruptions: window.__voiceInterruptions,
    contexts: window.__voiceResources.contexts.length,
    streams: window.__voiceResources.streams.length,
  }));
  NodeAssert.equal(metrics.ready, 1);
  NodeAssert.equal(metrics.errors, 1);
  NodeAssert.equal(metrics.commits, 2);
  NodeAssert.equal(metrics.stale, 2);
  NodeAssert.equal(metrics.stalePlayback, 0);
  NodeAssert.equal(metrics.playbackChunks, 2);
  NodeAssert.equal(metrics.playbackSamples, 24000);
  NodeAssert.equal(metrics.interruptions.length, 2);
  for (const row of metrics.epochs.filter((row) => row.enqueued > 0)) {
    NodeAssert.equal(row.enqueued, 12000);
    NodeAssert.ok(row.progress > 0);
    NodeAssert.ok(
      row.consumed >= row.progress && row.consumed < row.enqueued,
      "interrupt before playback drains",
    );
  }
  NodeAssert.ok(metrics.captureSamples >= 4800);
  NodeAssert.ok(metrics.progressSamples > 0);
  NodeAssert.ok(metrics.worklets >= 1);
  NodeAssert.deepEqual(errors, [], "browser page errors");
  console.log(
    JSON.stringify({
      passed: true,
      advertisedModels: fixture.advertisedModels,
      runtime: {
        node: process.version,
        chromium: browser.version(),
        chromiumSandbox: true,
      },
      metrics,
      explicitStopIdle: true,
      resourcesReleased: true,
    }),
  );
} catch (error) {
  console.error(error.stack);
  for (const error of errors) console.error(error);
  if (page) {
    console.error(
      JSON.stringify(await page.evaluate(() => window.__voiceOffline).catch(() => null)),
    );
    console.error(
      await page
        .locator("body")
        .innerText()
        .catch(() => "body unavailable"),
    );
  }
  process.exitCode = 1;
} finally {
  await close();
}
