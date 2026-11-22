import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  EventId,
  MessageId,
  TurnItemId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";

export { create, projectId, voice } from "../../orchestration-v2/VoiceConversation.testkit.ts";

/** Real stores and dispatch, with no effect worker or permissible provider connection. */
export const makeLayer = (
  path?: string,
  options?: {
    readonly wrapProjectionStore?: (
      store: ProjectionStore.ProjectionStoreV2Shape,
    ) => ProjectionStore.ProjectionStoreV2Shape;
  },
) => {
  const database =
    path === undefined
      ? SqlitePersistence.layerMemory
      : SqlitePersistence.layerFromPath(path).pipe(Layer.provide(NodeServices.layer));
  const adapter = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Unexpected provider open in footprint regression"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const foundation = Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    EventStore.layer.pipe(Layer.provide(database)),
    CommandReceiptStore.layer.pipe(Layer.provide(database)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "voice-footprint" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false, ...options },
    ),
  );
  return ThreadManagement.layer.pipe(
    Layer.provideMerge(foundation),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
  );
};

/** Synthetic domain snapshots, persisted through the real SQL projector. */
export const putMessage = Effect.fnUntraced(function* (input: {
  readonly threadId: import("@t3tools/contracts").ThreadId;
  readonly id: string;
  readonly ordinal: number;
  readonly text?: string;
  readonly role?: "user" | "assistant";
  readonly runId?: import("@t3tools/contracts").RunId;
  readonly voice?: import("@t3tools/contracts").OrchestrationV2VoiceMessage;
  readonly streaming?: boolean;
  readonly itemStreaming?: boolean;
  readonly notification?: import("@t3tools/contracts").OrchestrationV2ConversationMessage["notification"];
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const at = yield* DateTime.now;
  const role = input.role ?? "user";
  const message = {
    id: MessageId.make(input.id),
    threadId: input.threadId,
    runId: input.runId ?? null,
    nodeId: null,
    role,
    text: input.text ?? input.id,
    attachments: [],
    streaming: input.streaming ?? false,
    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
    creationSource: "web" as const,
    createdAt: at,
    updatedAt: at,
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.notification ? { notification: input.notification } : {}),
  };
  const base = {
    id: TurnItemId.make(`item:${input.id}`),
    threadId: input.threadId,
    runId: input.runId ?? null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    messageId: message.id,
    text: message.text,
    ...(input.voice ? { voice: input.voice } : {}),
  };
  const item =
    role === "user"
      ? {
          ...base,
          type: "user_message" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
          inputIntent: "conversation_only" as const,
          attachments: [],
        }
      : {
          ...base,
          type: "assistant_message" as const,
          streaming: input.itemStreaming ?? input.streaming ?? false,
        };
  yield* store.apply({
    id: EventId.make(`event:message:${input.id}`),
    type: "message.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload: message,
  });
  yield* store.apply({
    id: EventId.make(`event:item:${input.id}`),
    type: "turn-item.updated",
    threadId: input.threadId,
    occurredAt: at,
    payload: item,
  });
  return { message, item };
});
