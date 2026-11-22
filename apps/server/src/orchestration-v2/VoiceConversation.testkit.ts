import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2VoiceMessage,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { recordVoiceMessage } from "./VoiceConversation.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
export const projectId = ProjectId.make("project:voice-history");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Recording must never open a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const foundation = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "voice-history" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
export const layer = ThreadManagement.layer.pipe(
  Layer.provideMerge(foundation),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
);
export const voice: OrchestrationV2VoiceMessage = {
  sessionId: "voice-session",
  itemId: "input-one",
  sequence: 1,
  textKind: "final_user_transcript",
  delivery: "unknown",
};
export const create = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: "Voice",
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

export const seedLateVoiceHistory = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* create(threadId);
    const send = (id: string, text: string) =>
      threads.sendToThread({
        projectId,
        threadId,
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
    const normal = yield* send("normal-first", "FIRST_NORMAL_INPUT");
    yield* recordVoiceMessage({
      projectId,
      threadId,
      role: "user",
      text: "VOICE_BEFORE_DISPATCH",
      voice,
      creationSource: "web",
    });
    const queued = yield* send("queued-next", "CURRENT_EXECUTION_INPUT");
    yield* recordVoiceMessage({
      projectId,
      threadId,
      role: "user",
      text: "VOICE_AFTER_DISPATCH",
      voice: { ...voice, itemId: "later", sequence: 2 },
      creationSource: "web",
    });
    const after = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
    return { normal, queued, after };
  }).pipe(Effect.provide(layer));

export const seedCancelledVoiceHistory = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* create(threadId);
    const send = (id: string) =>
      threads.sendToThread({
        projectId,
        threadId,
        commandId: CommandId.make(id),
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      });
    yield* send("active-normal-task");
    const recorded = yield* recordVoiceMessage({
      projectId,
      threadId,
      role: "user",
      text: "CANCELLED_EXECUTION_CONVERSATION",
      voice,
      creationSource: "web",
    });
    const queuedVoice = yield* threads.sendToThread({
      projectId,
      threadId,
      messageId: recorded.messageId,
      commandId: CommandId.make("queue-historical-voice"),
      text: "CANCELLED_EXECUTION_CONVERSATION",
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "queued-run.cancel",
      commandId: CommandId.make("cancel-voice"),
      threadId,
      runId: queuedVoice.run.id,
    });
    const next = yield* send("CURRENT_EXECUTION_INPUT");
    const after = yield* store.getThreadRecords(threadId, ["messages", "turnItems", "runs"]);
    return { queuedVoice, next, after };
  }).pipe(Effect.provide(layer));
