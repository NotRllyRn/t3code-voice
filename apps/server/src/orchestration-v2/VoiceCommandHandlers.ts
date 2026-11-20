import {
  isProviderNativeSubagentThread,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { applyToProjection, type ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { voiceMessageId, voiceTurnItemId } from "./VoiceHistory.ts";

type VoiceRecordCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "voice.message.record" }
>;
type VoiceDispatchCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "message.dispatch" }
>;
type VoiceCommand = VoiceRecordCommand | VoiceDispatchCommand;
type VoiceUserTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;
type PendingEvents = Ref.Ref<Array<OrchestrationV2DomainEvent>>;

interface VoiceCommandDependencies<ProjectionError, DispatchError> {
  readonly projectionStore: Pick<
    ProjectionStoreV2Shape,
    "getThreadRecords" | "getNextTurnItemOrdinal"
  >;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: PendingEvents,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionError>;
  readonly nextTurnItemOrdinal: (
    projection: OrchestrationV2ThreadProjection,
  ) => Effect.Effect<number, ProjectionError>;
  readonly emit: (
    events: PendingEvents,
    command: VoiceCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, DispatchError>;
  readonly projectionError: (input: {
    readonly threadId: ThreadId;
    readonly cause: unknown;
  }) => ProjectionError;
  readonly dispatchError: (input: {
    readonly commandId: VoiceCommand["commandId"];
    readonly commandType: VoiceCommand["type"];
    readonly cause: string;
  }) => DispatchError;
}

export const voiceMessageFields = (message: OrchestrationV2ConversationMessage | undefined) =>
  message?.voice === undefined ? {} : { voice: message.voice, createdAt: message.createdAt };

export const voiceTurnItemFields = (item: VoiceUserTurnItem | undefined) =>
  item === undefined
    ? {}
    : {
        id: item.id,
        ordinal: item.ordinal,
        voice: item.voice,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      };

export const makeVoiceCommandHandlers = <ProjectionError, DispatchError>({
  projectionStore,
  getProjectionWithPendingEvents,
  nextTurnItemOrdinal,
  emit,
  projectionError,
  dispatchError,
}: VoiceCommandDependencies<ProjectionError, DispatchError>) => {
  const withVoiceRecords = Effect.fn("Orchestrator.withVoiceRecords")(function* (
    projection: OrchestrationV2ThreadProjection,
    messageIds: ReadonlyArray<MessageId>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    // The normal command projection deliberately excludes assistant messages.
    const records = yield* projectionStore
      .getThreadRecords(projection.thread.id, ["messages", "turnItems"], {
        messageIds,
        turnItemIds: messageIds.map(voiceTurnItemId),
      })
      .pipe(
        // A child thread can be created and dispatched in the same command, before
        // projection persistence. Its validated projection and records are in events below.
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed({ messages: [], turnItems: [] }),
        }),
        Effect.mapError((cause) => projectionError({ threadId: projection.thread.id, cause })),
      );
    let result: OrchestrationV2ThreadProjection = {
      ...projection,
      messages: [
        ...new Map(
          [...projection.messages, ...records.messages].map((item) => [item.id, item]),
        ).values(),
      ],
      turnItems: [
        ...new Map(
          [
            ...projection.turnItems,
            ...records.turnItems.filter((item) => item.voice !== undefined),
          ].map((item) => [item.id, item]),
        ).values(),
      ],
    };
    for (const event of yield* Ref.get(events)) {
      if (event.threadId === projection.thread.id) result = applyToProjection(result, event);
    }
    return result;
  });

  const prepareVoiceDispatch = Effect.fn("Orchestrator.prepareVoiceDispatch")(function* (
    command: VoiceDispatchCommand,
    projection: OrchestrationV2ThreadProjection,
    events: PendingEvents,
  ) {
    projection = yield* withVoiceRecords(projection, [command.messageId], events);
    const recordedVoice = projection.messages.find((message) => message.id === command.messageId);
    const recordedVoiceItem = projection.turnItems.find(
      (item): item is VoiceUserTurnItem =>
        item.type === "user_message" &&
        item.messageId === command.messageId &&
        item.voice !== undefined,
    );
    if (recordedVoice?.voice !== undefined) {
      if (
        recordedVoice.role !== "user" ||
        recordedVoice.text !== command.text ||
        recordedVoice.createdBy !== command.createdBy ||
        recordedVoice.creationSource !== command.creationSource ||
        recordedVoiceItem === undefined ||
        command.attachments.length > 0 ||
        (command.dispatchMode.type !== "queue_after_active" &&
          command.dispatchMode.type !== "start_immediately")
      ) {
        return yield* Effect.fail(
          dispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause:
              "Only the recorded voice user input can be dispatched, without rewriting or steering.",
          }),
        );
      }
      if (recordedVoice.runId !== null) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          occurredAt: yield* DateTime.now,
          payload: projection.thread,
        });
        return { type: "replayed" as const };
      }
    }
    // Freeze the committed conversation high-water mark, not a proposed/pre-normalized position.
    const lastStoredOrdinal =
      (yield* projectionStore
        .getNextTurnItemOrdinal(command.threadId)
        .pipe(Effect.mapError((cause) => projectionError({ threadId: command.threadId, cause })))) -
      1;
    // Later voice replies stay visible now but enter provider history before the next eligible turn.
    const historyOrdinal = recordedVoiceItem ? recordedVoiceItem.ordinal - 1 : lastStoredOrdinal;
    const voiceHistoryCutoffOrdinal = historyOrdinal > 0 ? historyOrdinal : undefined;
    return {
      type: "prepared" as const,
      projection,
      recordedVoice,
      recordedVoiceItem,
      voiceHistoryCutoffOrdinal,
    };
  });

  const recordVoiceMessage = Effect.fn("Orchestrator.recordVoiceMessage")(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "voice.message.record" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* withVoiceRecords(
      yield* getProjectionWithPendingEvents(command.threadId, events),
      [command.messageId, ...(command.voice.sourceMessageIds ?? [])],
      events,
    );
    const reject = () =>
      dispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "Invalid or conflicting canonical voice record.",
      });
    if (
      projection.thread.deletedAt !== null ||
      projection.thread.archivedAt !== null ||
      isProviderNativeSubagentThread(projection.thread) ||
      command.messageId !== voiceMessageId(command.role, command.voice) ||
      command.text.trim().length === 0 ||
      command.text.length > 64_000 ||
      (command.role === "user"
        ? command.voice.textKind !== "final_user_transcript" || command.createdBy !== "user"
        : command.voice.textKind !== "generated_voice_reply" ||
          command.createdBy !== "agent" ||
          command.creationSource !== "server" ||
          command.voice.responseId === undefined)
    )
      return yield* Effect.fail(reject());
    if (
      (command.voice.sourceRunId !== undefined &&
        !projection.runs.some((run) => run.id === command.voice.sourceRunId)) ||
      command.voice.sourceMessageIds?.some(
        (id) => !projection.messages.some((message) => message.id === id),
      )
    )
      return yield* Effect.fail(reject());
    const existing = projection.messages.find((message) => message.id === command.messageId);
    const item = projection.turnItems.find(
      (candidate) =>
        (candidate.type === "user_message" || candidate.type === "assistant_message") &&
        candidate.messageId === command.messageId,
    );
    if (existing !== undefined) {
      const immutableVoice = (voice: NonNullable<typeof existing.voice>) => [
        voice.sessionId,
        voice.itemId,
        voice.sequence,
        voice.responseId,
        voice.contentIndex ?? 0,
        voice.predecessorItemId,
        voice.textKind,
        voice.sourceRunId,
        ...(voice.sourceMessageIds ?? []),
      ];
      if (
        existing.voice === undefined ||
        item === undefined ||
        existing.text !== command.text ||
        existing.role !== command.role ||
        existing.createdBy !== command.createdBy ||
        existing.creationSource !== command.creationSource ||
        immutableVoice(existing.voice).length !== immutableVoice(command.voice).length ||
        !immutableVoice(existing.voice).every(
          (value, index) => value === immutableVoice(command.voice)[index],
        )
      )
        return yield* Effect.fail(reject());
    }
    const now = yield* DateTime.now;
    // An old drain receipt cannot undo a known interruption or disconnect.
    const voice =
      existing?.voice !== undefined &&
      (existing.voice.delivery === "interrupted" || existing.voice.delivery === "unknown") &&
      command.voice.delivery === "drained"
        ? existing.voice
        : command.voice;
    const message: OrchestrationV2ConversationMessage =
      existing === undefined
        ? {
            id: command.messageId,
            threadId: command.threadId,
            runId: null,
            nodeId: null,
            role: command.role,
            text: command.text,
            attachments: [],
            streaming: false,
            createdBy: command.createdBy,
            creationSource: command.creationSource,
            createdAt: now,
            updatedAt: now,
            voice,
          }
        : { ...existing, voice, updatedAt: now };
    const base = {
      id: voiceTurnItemId(command.messageId),
      threadId: command.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: item?.ordinal ?? (yield* nextTurnItemOrdinal(projection)),
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      messageId: command.messageId,
      text: command.text,
      voice,
    };
    const turnItem: OrchestrationV2TurnItem =
      item !== undefined
        ? { ...item, voice, updatedAt: now }
        : command.role === "user"
          ? {
              ...base,
              type: "user_message",
              inputIntent: "conversation_only",
              createdBy: command.createdBy,
              creationSource: command.creationSource,
              attachments: [],
            }
          : { ...base, type: "assistant_message", streaming: false };
    yield* emit(
      events,
      command,
    )({ type: "message.updated", threadId: command.threadId, occurredAt: now, payload: message });
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: command.threadId,
      occurredAt: now,
      payload: turnItem,
    });
  });

  return { prepareVoiceDispatch, recordVoiceMessage };
};
