import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as NodeUtil from "node:util";
import { makePrivateCodexLiveConnection, readPrivateCodexLiveConfig } from "./CodexLiveConfig.ts";
import config from "./testFixtures/codex-0.169.0-live-config.json" with { type: "json" };

const secret = "fictional-private-bearer";
const launch = {
  binaryPath: "/fake/codex",
  homePath: "/fixture/shadow",
  launchArgs: "",
  environment: { FIXTURE_ENV: "captured" },
};

function fakeAppServer(result: unknown, mode: "result" | "error" | "hang" = "result") {
  const requested = Deferred.makeUnsafe<void>();
  const processes: Array<{ command: ChildProcess.Command; closed: boolean }> = [];
  const requests: Array<{ method: string; params?: unknown }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const process = { command, closed: false };
      processes.push(process);
      yield* Effect.addFinalizer(() => Effect.sync(() => (process.closed = true)));
      const respond = (frame: unknown) =>
        Queue.offer(output, new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_000 + processes.length),
        exitCode: Deferred.await(exited),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: string | Uint8Array) =>
          Effect.forEach(
            (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
              .split("\n")
              .filter(Boolean),
            (line) => {
              const frame = JSON.parse(line) as { id?: number; method: string; params?: unknown };
              requests.push(frame);
              if (frame.id === undefined) return Effect.void;
              if (frame.method === "initialize")
                return respond({
                  id: frame.id,
                  result: {
                    codexHome: launch.homePath,
                    platformFamily: "unix",
                    platformOs: "linux",
                    userAgent: "fixture",
                  },
                });
              if (mode === "hang") return Deferred.succeed(requested, undefined);
              return respond(
                mode === "error"
                  ? { id: frame.id, error: { code: -32000, message: secret, data: { secret } } }
                  : { id: frame.id, result },
              );
            },
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { processes, requests, spawner, requested };
}

it.effect("reads raw config privately and closes only the owned process scope", () =>
  Effect.gen(function* () {
    // Intentionally outside the typed config/read schema: the reader must use raw.request.
    const raw = { private: secret, unexpected: [1, true] };
    const fake = fakeAppServer(raw);
    const value = yield* readPrivateCodexLiveConfig(launch).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    );
    assert.deepStrictEqual(Redacted.value(value), raw);
    assert.isFalse(NodeUtil.inspect(value).includes(secret));
    assert.deepStrictEqual(
      fake.requests.map(({ method }) => method),
      ["initialize", "initialized", "config/read"],
    );
    assert.deepStrictEqual(fake.requests.at(-1)?.params, { includeLayers: true });
    assert.strictEqual(fake.processes.length, 1);
    assert.isTrue(fake.processes[0]!.closed);
  }),
);

it.effect.each([
  { name: "RPC failure", mode: "error", response: null },
  {
    name: "oversized UTF-8 config",
    mode: "result",
    response: { secret, padding: "é".repeat(131072) },
  },
] as const)("returns a generic error without secrets for $name", ({ mode, response }) =>
  Effect.gen(function* () {
    const fake = fakeAppServer(response, mode);
    const error = yield* readPrivateCodexLiveConfig(launch).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      Effect.flip,
    );
    assert.strictEqual(error._tag, "LiveConnectionError");
    assert.strictEqual(error.reason, "unsupported-provider");
    assert.isFalse(NodeUtil.inspect(error).includes(secret));
    assert.isFalse(JSON.stringify(error).includes(secret));
    assert.isUndefined((error as { cause?: unknown }).cause);
    assert.isTrue(fake.processes[0]!.closed);
  }),
);

it.effect("accepts exactly 262144 encoded bytes and rejects the next byte", () =>
  Effect.gen(function* () {
    for (const bytes of [262144, 262145]) {
      const raw = {
        secret,
        padding: "x".repeat(bytes - JSON.stringify({ secret, padding: "" }).length),
      };
      const fake = fakeAppServer(raw);
      const result = yield* readPrivateCodexLiveConfig(launch).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        Effect.result,
      );
      assert.strictEqual(result._tag, bytes === 262144 ? "Success" : "Failure");
      assert.isTrue(fake.processes[0]!.closed);
    }
  }),
);

it.effect("times out after five seconds and closes the owned helper", () =>
  Effect.gen(function* () {
    const fake = fakeAppServer(null, "hang");
    const read = yield* readPrivateCodexLiveConfig(launch).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      Effect.flip,
      Effect.forkChild,
    );
    yield* Deferred.await(fake.requested);
    yield* TestClock.adjust("4 seconds");
    assert.strictEqual(fake.requests.at(-1)?.method, "config/read");
    assert.isFalse(fake.processes[0]!.closed);
    yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(read);
    assert.strictEqual(error.reason, "unsupported-provider");
    assert.isFalse(NodeUtil.inspect(error).includes(secret));
    assert.isTrue(fake.processes[0]!.closed);
  }),
);

it.effect("factory resolves lazily using captured services and effective config", () =>
  Effect.gen(function* () {
    const fake = fakeAppServer(config);
    const connection = yield* makePrivateCodexLiveConnection(launch).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    );
    assert.strictEqual(fake.processes.length, 0);
    const resolved = yield* connection.resolveLiveConnection();
    assert.strictEqual(resolved.createUrl, "https://relay.example.test/prefix/v1/live");
    assert.strictEqual(Redacted.value(resolved.headers).Authorization, `Bearer ${secret}`);
    assert.isFalse(NodeUtil.inspect(resolved).includes(secret));
    assert.strictEqual(fake.processes.length, 1);
    assert.isTrue(fake.processes[0]!.closed);
  }),
);

it.effect("factory keeps effective binary, home, environment and launch-arg precedence", () =>
  Effect.gen(function* () {
    const fake = fakeAppServer(config);
    const connection = yield* makePrivateCodexLiveConnection({
      ...launch,
      homePath: "~/shadow",
      launchArgs: "--profile ignored",
      environment: { ...launch.environment, T3CODE_CODEX_LAUNCH_ARGS: "--profile effective" },
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      Effect.provideService(HostProcess.HomeDirectory, "/captured-home"),
    );
    assert.strictEqual(fake.processes.length, 0);
    yield* connection
      .resolveLiveConnection()
      .pipe(Effect.provideService(HostProcess.HomeDirectory, "/wrong-home"), Effect.flip);
    assert.strictEqual(fake.processes.length, 1);
    const command = fake.processes[0]!.command;
    assert.deepInclude(command, {
      command: "/fake/codex",
      args: ["app-server", "-c", "thread_unload_delay_secs=0", "--profile", "effective"],
    });
    assert.deepNestedInclude(command, {
      "options.cwd": "~/shadow",
      "options.env.CODEX_HOME": "/captured-home/shadow",
      "options.env.FIXTURE_ENV": "captured",
    });
    assert.strictEqual(fake.requests.at(-1)?.method, "config/read");
    assert.isTrue(fake.processes[0]!.closed);
  }),
);
