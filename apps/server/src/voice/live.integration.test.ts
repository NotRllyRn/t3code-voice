// @effect-diagnostics-next-line nodeBuiltinImport:off -- Scoped fictional loopback CPA; no external provider calls.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  LIVE_VOICE_PATH,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type LiveVoiceServerEvent,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { LiveVoiceController } from "../../../../packages/client-runtime/src/voice-conversation/liveController.ts";
import type { LiveMediaOptions } from "../../../../packages/client-runtime/src/voice-conversation/liveMedia.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as VoiceFixture from "../orchestration-v2/VoiceConversation.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { makeLiveAgentSession, sendLiveDelegation } from "./liveAgentSession.ts";
import type { NativeLiveAppend } from "./liveProtocol.ts";
import { liveVoiceRouteLayer } from "./liveRoute.ts";
import { VoiceOwners } from "./owner.ts";
import { VoiceWebSocket } from "./transport.ts";
import { connection, sdp } from "./liveTestkit.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread:offline-live-integration");
const original = "Please inspect the fictional configuration.";
const instructions =
  "Inspect the fictional configuration and report the result without changing it.";
const nativeDelegation = (id: string) => ({
  type: "delegation.created",
  item: {
    id,
    type: "delegation",
    target: "client",
    content: [{ type: "input_text", text: instructions }],
  },
});
const take = <A>(queue: Queue.Queue<A>, predicate: (value: A) => boolean) =>
  Queue.take(queue).pipe(Effect.repeat({ until: predicate }));
const agentServices = Layer.mergeAll(
  VoiceFixture.layer,
  Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/fictional/projects",
  }),
);

const setup = Effect.fn("LiveIntegration.setup")(function* (mode: "refresh" | "terminal") {
  const browserEvents = yield* Queue.unbounded<LiveVoiceServerEvent>();
  const nativeFrames = yield* Queue.unbounded<Record<string, unknown>>();
  const providerEvents = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2TurnInput>();
  const hangups = yield* Queue.unbounded<void>();
  const requests: string[] = [];
  const offers: string[] = [];
  let allocations = 0;
  let native: NodeWS.WebSocket | undefined;
  const up = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const http = NodeHttp.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push(request.url!);
          if (request.url?.endsWith("/hangup")) {
            response.writeHead(200).end();
            Queue.offerUnsafe(hangups, undefined);
          } else {
            offers.push(JSON.parse(body).sdp);
            if (offers.length === 1 || mode === "terminal") {
              response.writeHead(mode === "terminal" ? 401 : 503, {
                "Content-Type": "application/json",
              });
              response.end(
                JSON.stringify({
                  error: { code: mode === "terminal" ? "unauthorized" : "refresh_failed" },
                }),
              );
            } else {
              allocations++;
              response.writeHead(201, {
                "Content-Type": "application/sdp",
                Location: "/v1/live/fictional-owned",
              });
              response.end(sdp);
            }
          }
        });
      });
      const ws = new NodeWS.WebSocketServer({ server: http });
      ws.on("connection", (socket) => {
        native = socket;
        socket.on("message", (frame) =>
          Queue.offerUnsafe(nativeFrames, JSON.parse(frame.toString())),
        );
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback fixture port");
      return { http, ws, origin: `http://127.0.0.1:${address.port}` };
    }),
    (up) =>
      Effect.promise(async () => {
        up.ws.clients.forEach((socket) => socket.terminate());
        await new Promise<void>((resolve) => up.http.close(() => resolve()));
        up.ws.close();
      }),
  );
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/fictional/workspace",
            model: "gpt-5",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(providerEvents),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "fictional-native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) => Queue.offer(started, turn).pipe(Effect.asVoid),
          steerTurn: () => Effect.die("Voice must not steer an existing coding turn"),
          interruptTurn: () => Effect.die("Stop must not cancel the coding task"),
          respondToRuntimeRequest: () => Effect.die("Voice cannot answer approval requests"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const database = SqlitePersistence.layerMemory;
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "offline-live-integration" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(
    Layer.provideMerge(runtime),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  );
  const auth = EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provideMerge(database),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-offline-live-integration-" }),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const provider: ProviderInstance = {
    instanceId,
    enabled: true,
    driverKind: driver,
    displayName: undefined,
    continuationIdentity: { driverKind: driver, continuationKey: "fictional" },
    liveConnection: {
      resolveLiveConnection: () =>
        Effect.succeed({ ...connection, createUrl: `${up.origin}/v1/live` }),
    },
    get snapshot(): never {
      throw new Error("No public snapshot credentials");
    },
    get orchestrationAdapter(): never {
      throw new Error("Use normal T3 adapter registry");
    },
    get textGeneration(): never {
      throw new Error("No parallel voice executor");
    },
  };
  const services = yield* Layer.build(
    HttpRouter.serve(
      liveVoiceRouteLayer.pipe(
        Layer.provide(threads),
        Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
        Layer.provide(
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/fictional/projects",
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(provider),
          }),
        ),
        Layer.provide(Layer.succeed(VoiceOwners, new Set<string>())),
      ),
      { disableListenLog: true },
    ).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          websocket: { WebSocket: VoiceWebSocket, perMessageDeflate: false },
        }),
      ),
      Layer.provideMerge(threads),
      Layer.provideMerge(auth),
      Layer.provide(FetchHttpClient.layer),
    ),
  );
  const orchestrator = Context.get(services, Orchestrator.OrchestratorV2);
  const management = Context.get(services, ThreadManagement.ThreadManagementService);
  const worker = Context.get(services, EffectWorker.OrchestrationEffectWorkerV2);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:offline-live"),
    threadId,
    projectId: VoiceFixture.projectId,
    title: "Fictional inspection",
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const session = yield* Context.get(services, SessionStore.SessionStore).issue({
    scopes: [AuthOrchestrationOperateScope],
  });
  const origin = HttpServer.formatAddress(
    Context.get(services, HttpServer.HttpServer).address,
  ).replace(/^http/, "ws");
  const media: Array<{ options: LiveMediaOptions; disposed: boolean; mic: boolean }> = [];
  let browser: NodeWS.WebSocket | undefined;
  const controller = new LiveVoiceController(
    {
      url: async () => `${origin}${LIVE_VOICE_PATH}?threadId=${encodeURIComponent(threadId)}`,
      socket: (url) => {
        browser = new NodeWS.WebSocket(url, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
        return browser;
      },
      media: async (options) => {
        const current = { options, disposed: false, mic: false };
        media.push(current);
        return {
          offer: async () => sdp.replace("42 2", `${42 + media.length} ${2 + media.length}`),
          answer: async () => {},
          playback: async () => {},
          microphone: (enabled) => {
            current.mic = enabled;
          },
          dispose: () => {
            current.disposed = true;
            current.mic = false;
          },
        };
      },
      event: (event) => {
        Queue.offerUnsafe(browserEvents, event);
      },
    },
    () => {},
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      controller.dispose();
      browser?.terminate();
    }),
  );
  return {
    controller,
    browserEvents,
    nativeFrames,
    providerEvents,
    started,
    hangups,
    offers,
    requests,
    media,
    management,
    orchestrator,
    worker,
    allocationCount: () => allocations,
    native: (event: unknown) => native!.send(JSON.stringify(event)),
    heartbeat: () => browser!.send('{"type":"live.heartbeat"}'),
  };
});

it.effect(
  "controller → authenticated route → native delegation → one normal T3 provider turn → canonical result → Stop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup("refresh");
        yield* Effect.promise(() => f.controller.start());
        const wait = yield* take(
          f.browserEvents,
          (event) => event.type === "live.status" && event.phase === "refresh_wait",
        );
        expect(wait.type === "live.status" && wait.retryAt).toBe(90000);
        expect(f.offers).toHaveLength(1);
        expect(f.media[0]?.disposed).toBe(true);
        for (let tick = 0; tick < 8; tick++) {
          f.heartbeat();
          yield* TestClock.adjust("10 seconds");
        }
        expect(f.offers).toHaveLength(1);
        f.heartbeat();
        yield* TestClock.adjust("10 seconds");
        yield* take(f.browserEvents, (event) => event.type === "live.answer");
        expect(f.offers).toHaveLength(2);
        expect(f.offers[0]).not.toBe(f.offers[1]);
        expect(f.allocationCount()).toBe(1);
        expect(f.controller.state.phase).toBe("connecting");
        expect(f.media[1]?.mic).toBe(false);
        f.native({ type: "session.started", session: { id: "fictional-native-session" } });
        yield* take(f.nativeFrames, (frame) => frame.type === "session.context.append");
        expect(f.controller.state.phase).toBe("connecting");
        f.media[1]!.options.peer("connected");
        yield* take(
          f.browserEvents,
          (event) => event.type === "live.status" && event.phase === "connected",
        );
        f.native({
          type: "turn.done",
          turn: { id: "fictional-user-turn", role: "user", transcript: original },
        });
        yield* take(f.browserEvents, (event) => event.type === "live.caption" && event.committed);
        expect((yield* f.management.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
        f.native(nativeDelegation("fictional-delegation"));
        const accepted = yield* take(f.browserEvents, (event) => event.type === "live.agent");
        expect(accepted.type === "live.agent" && accepted.status).toBe("accepted");
        const history = yield* f.management.getThreadRecords(threadId, ["messages", "runs"]);
        expect(history.runs).toHaveLength(1);
        expect(history.messages.filter((message) => message.text === original)).toHaveLength(1);
        const caption = history.messages.find((message) => message.text === original)!;
        expect(caption.voice?.transcriptFinality).toBe("application_frozen");
        expect(caption.voice?.delivery).toBe("unknown");
        const derived = history.messages.find((message) =>
          message.text.includes("Live delegated instruction"),
        )!;
        expect(derived.createdBy).toBe("agent");
        expect(derived.creationSource).toBe("server");
        expect(derived.text).toContain("NOT a verbatim human quotation");
        expect(derived.text).toContain(instructions);
        expect(derived.text).toContain(original);
        const receipt = yield* sendLiveDelegation({
          projectId: VoiceFixture.projectId,
          threadId,
          sessionId: caption.voice!.sessionId,
          delegationId: "fictional-delegation",
          instructions,
          context: [{ role: "user", text: original }],
        }).pipe(Effect.provideService(ThreadManagement.ThreadManagementService, f.management));
        expect(receipt.run.id).toBe(history.runs[0]!.id);
        expect(receipt.message.id).toBe(derived.id);
        // Replays and assistant speech do not create another coding request.
        f.native(nativeDelegation("fictional-delegation"));
        f.native(nativeDelegation("fictional-replay"));
        f.native({
          type: "turn.done",
          turn: {
            id: "fictional-voice-claim",
            role: "assistant",
            transcript: "Everything succeeded.",
          },
        });
        yield* take(
          f.browserEvents,
          (event) => event.type === "live.caption" && event.committed && event.role === "assistant",
        );
        yield* f.worker.drain();
        const turn = yield* Queue.take(f.started);
        expect(turn.message.text).toContain(derived.text);
        expect(turn.message.text).toContain("Historical user; user_message");
        expect(turn.runtimePolicy.runtimeMode).toBe("approval-required");
        expect((yield* f.management.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
        const running = yield* f.orchestrator.getThreadProjection(threadId);
        const now = yield* DateTime.now;
        const providerTurn = {
          id: ProviderTurnId.make("fictional-provider-turn"),
          providerThreadId: turn.providerThread.id,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          ordinal: turn.providerTurnOrdinal,
          nativeTurnRef: { driver, nativeId: "fictional-turn", strength: "strong" as const },
          status: "completed" as const,
          startedAt: now,
          completedAt: now,
        };
        const finalId = MessageId.make("fictional-authored-result");
        const final = "Inspected the fictional configuration. No files were changed.";
        const finalWritten = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "message.updated" && event.payload.id === finalId,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(f.providerEvents, {
          type: "message.updated",
          driver,
          message: {
            ...derived,
            id: finalId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            role: "assistant",
            text: final,
            streaming: false,
            createdBy: "agent",
            creationSource: "server",
          },
        });
        yield* Fiber.join(finalWritten);
        expect(running.runs[0]?.id).toBe(turn.runId);
        const terminal = yield* f.orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "waiting",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(f.providerEvents, {
          type: "provider_turn.updated",
          driver,
          providerTurn,
        });
        yield* Queue.offer(f.providerEvents, {
          type: "turn.terminal",
          driver,
          providerThreadId: providerTurn.providerThreadId,
          providerTurnId: providerTurn.id,
          runOrdinal: turn.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(terminal);
        yield* f.worker.drain();
        f.heartbeat();
        yield* TestClock.adjust("1 second");
        yield* take(
          f.browserEvents,
          (event) => event.type === "live.agent" && event.status === "completed",
        );
        const result = yield* take(f.nativeFrames, (frame) =>
          JSON.stringify(frame).includes("actualAgentResult"),
        );
        expect(JSON.stringify(result)).toContain(final);
        expect(JSON.stringify(result)).not.toContain("Everything succeeded");
        expect(yield* Queue.size(f.started)).toBe(0);
        const completed = yield* f.management.getThreadRecords(threadId, ["runs", "messages"]);
        expect(completed.runs).toHaveLength(1);
        expect(completed.runs[0]?.status).toBe("completed");
        expect(completed.messages.find((message) => message.id === finalId)?.text).toBe(final);
        f.controller.stop();
        yield* Queue.take(f.hangups);
        expect(f.controller.state.phase).toBe("idle");
        expect(f.media.every((media) => media.disposed && !media.mic)).toBe(true);
        expect(f.requests.filter((url) => url.endsWith("/hangup"))).toHaveLength(1);
      }),
    ),
);

it.effect.each(["terminal", "stop-wait"] as const)("%s never retries or admits coding", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* setup(mode === "terminal" ? "terminal" : "refresh");
      yield* Effect.promise(() => f.controller.start());
      yield* take(
        f.browserEvents,
        (event) =>
          event.type === "live.status" &&
          event.phase === (mode === "terminal" ? "error" : "refresh_wait"),
      );
      if (mode === "stop-wait") f.controller.stop();
      yield* TestClock.adjust("180 seconds");
      expect(f.offers).toHaveLength(1);
      expect(f.allocationCount()).toBe(0);
      expect((yield* f.management.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
      expect(f.media.every((media) => media.disposed)).toBe(true);
      expect(f.controller.state.phase).toBe(mode === "terminal" ? "error" : "idle");
    }),
  ),
);

it.effect.each([false, true])(
  "does not lose typed acknowledgments or terminal tracking when more than eight runs accumulate (join existing: %s)",
  (joinExisting) =>
    Effect.scoped(
      Effect.gen(function* () {
        const id = ThreadId.make("thread:fictional-nine-typed");
        yield* VoiceFixture.create(id);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const events: LiveVoiceServerEvent[] = [];
        const appends: NativeLiveAppend[] = [];
        const agent = yield* makeLiveAgentSession({
          binding: { threadId: id },
          sessionId: "fictional-nine-session",
          onBound: () => {},
          send: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          append: (event) =>
            Effect.sync(() => {
              appends.push(event);
            }),
        });
        if (!joinExisting) yield* agent.seed;
        const accepted: Array<Awaited<Effect.Success<ReturnType<typeof threads.sendToThread>>>> =
          [];
        for (let n = 0; n < (joinExisting ? 10 : 9); n++) {
          accepted.push(
            yield* threads.sendToThread({
              projectId: VoiceFixture.projectId,
              threadId: id,
              commandId: CommandId.make(`fictional-typed-${n}`),
              messageId: MessageId.make(`fictional-typed-${n}`),
              text: `Fictional typed request ${n}. Do not change files.`,
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "web",
            }),
          );
          if (!joinExisting && n === 4) yield* agent.poll;
        }
        if (joinExisting) yield* agent.seed;
        yield* agent.poll;
        for (const queued of accepted.slice(1)) {
          yield* threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`cancel:${queued.run.id}`),
            threadId: id,
            runId: queued.run.id,
          });
        }
        // Free all queued tracker slots, then read again: an admission cap must defer, not forget.
        yield* agent.poll;
        yield* agent.poll;
        expect((yield* threads.getThreadRecords(id, ["runs"])).runs).toHaveLength(
          joinExisting ? 10 : 9,
        );
        const acknowledgments = events.filter(
          (event) => event.type === "live.agent" && ["accepted", "queued"].includes(event.status),
        );
        const terminal = events.filter(
          (event) => event.type === "live.agent" && event.status === "failed",
        );
        expect({
          acknowledgmentIds: acknowledgments.map(
            (event) => event.type === "live.agent" && event.runId,
          ),
          terminalIds: terminal.map((event) => event.type === "live.agent" && event.runId),
          speakableAcknowledgments: appends.filter(
            (append) =>
              append.channel === "speakable" &&
              append.text.includes("T3 accepted the typed request"),
          ).length,
        }).toEqual({
          acknowledgmentIds: joinExisting ? [] : accepted.map((sent) => sent.run.id),
          terminalIds: accepted.slice(1).map((sent) => sent.run.id),
          speakableAcknowledgments: joinExisting ? 0 : 9,
        });
      }),
    ).pipe(Effect.provide(agentServices)),
);

it.effect("assistant feedback alone cannot re-authorize a terminal delegation under a new ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const id = ThreadId.make("thread:fictional-no-voice-feedback-loop");
      yield* VoiceFixture.create(id);
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* threads.sendToThread({
        projectId: VoiceFixture.projectId,
        threadId: id,
        commandId: CommandId.make("fictional-occupying-task"),
        messageId: MessageId.make("fictional-occupying-task"),
        text: "An existing fictional coding task.",
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
      const events: LiveVoiceServerEvent[] = [];
      const agent = yield* makeLiveAgentSession({
        binding: { threadId: id },
        sessionId: "fictional-feedback-loop",
        onBound: () => {},
        send: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        append: () => Effect.void,
      });
      yield* agent.seed;
      yield* agent.receive({
        type: "turn_done",
        role: "user",
        turnId: "fictional-original",
        text: original,
      });
      const delegation = {
        type: "delegation",
        delegationId: "fictional-once",
        instructions,
        provenance: "native_live_delegation",
      } as const;
      yield* agent.receive(delegation);
      const first = yield* threads.getThreadRecords(id, ["runs"]);
      expect(first.runs).toHaveLength(2);
      const queued = first.runs[1]!;
      yield* threads.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("fictional-cancel"),
        threadId: id,
        runId: queued.id,
      });
      yield* agent.poll;
      expect(
        events.some(
          (event) =>
            event.type === "live.agent" && event.runId === queued.id && event.status === "failed",
        ),
      ).toBe(true);
      // A new assistant caption changes context, but supplies no new human request or execution authority.
      yield* agent.receive({
        type: "turn_done",
        role: "assistant",
        turnId: "fictional-generated-feedback",
        text: "The fictional task ended. No new work was requested.",
      });
      yield* agent.receive({ ...delegation, delegationId: "fictional-feedback-replay" });
      expect((yield* threads.getThreadRecords(id, ["runs"])).runs).toHaveLength(2);
    }),
  ).pipe(Effect.provide(agentServices)),
);
