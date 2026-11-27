import type {
  MessageId,
  ModelSelection,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

type VoiceUserTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;

export interface VoiceDispatchExpectations {
  readonly expectedUserMessageCount?: number;
  readonly expectedModelSelection?: ModelSelection;
}

export const findRecordedVoice = (
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  messageId: MessageId,
) => ({
  recordedVoice: projection.messages.find((message) => message.id === messageId),
  recordedVoiceItem: projection.turnItems.find(
    (item): item is VoiceUserTurnItem =>
      item.type === "user_message" && item.messageId === messageId && item.voice !== undefined,
  ),
});

export const voiceTurnOrdinal = Effect.fnUntraced(function* <E>(
  voiceHistoryCutoffOrdinal: number | undefined,
  ordinal: number,
  nextOrdinal: () => Effect.Effect<number, E>,
) {
  return voiceHistoryCutoffOrdinal === undefined
    ? ordinal * 100
    : Math.max(ordinal * 100, yield* nextOrdinal());
});

export const assertExpectedDispatchState = Effect.fnUntraced(function* <
  ProjectionError,
  InputChangedError,
>(input: {
  readonly command: OrchestrationV2ServerCommand;
  readonly options: VoiceDispatchExpectations | undefined;
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadShell" | "getThreadRecords">;
  readonly projectionError: (input: {
    readonly threadId: ThreadId;
    readonly cause: unknown;
  }) => ProjectionError;
  readonly inputChangedError: (input: { readonly threadId: ThreadId }) => InputChangedError;
}) {
  const { command, options, projectionStore, projectionError, inputChangedError } = input;
  if (command.type !== "message.dispatch" || options === undefined) return;
  if (options.expectedModelSelection !== undefined) {
    const shell = yield* projectionStore
      .getThreadShell(command.threadId)
      .pipe(Effect.mapError((cause) => projectionError({ threadId: command.threadId, cause })));
    if (!shell || !modelSelectionsEqual(shell.modelSelection, options.expectedModelSelection)) {
      return yield* Effect.fail(inputChangedError({ threadId: command.threadId }));
    }
  }
  if (options.expectedUserMessageCount !== undefined) {
    const { messages } = yield* projectionStore
      .getThreadRecords(command.threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.mapError((cause) => projectionError({ threadId: command.threadId, cause })));
    if (messages.filter((message) => !message.voice).length !== options.expectedUserMessageCount) {
      return yield* Effect.fail(inputChangedError({ threadId: command.threadId }));
    }
  }
});
