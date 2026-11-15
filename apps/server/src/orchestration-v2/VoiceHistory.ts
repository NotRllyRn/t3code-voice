// @effect-diagnostics-next-line nodeBuiltinImport:off -- receipt IDs must be derived synchronously from immutable input.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  CommandId,
  ContextHandoffId,
  MessageId,
  TurnItemId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type OrchestrationV2VoiceMessage,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";

export function voiceMessageId(
  role: "user" | "assistant",
  voice: Pick<OrchestrationV2VoiceMessage, "sessionId" | "itemId" | "contentIndex">,
): MessageId {
  return MessageId.make(
    `message:voice:${[voice.sessionId, role, voice.itemId, String(voice.contentIndex ?? 0)].map(encodeURIComponent).join(":")}`,
  );
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function voiceRecordCommandId(input: unknown): CommandId {
  return CommandId.make(
    `command:voice:record:${NodeCrypto.createHash("sha256").update(encodeJson(input)).digest("hex")}`,
  );
}

export function voiceTurnItemId(messageId: MessageId): TurnItemId {
  return TurnItemId.make(`turn-item:voice:${messageId}`);
}

export function voiceHistoryBoundaryOrdinal(
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): number {
  return (
    runs.findLast((source) => source.freshContext === true && source.ordinal <= run.ordinal)
      ?.voiceHistoryCutoffOrdinal ?? 0
  );
}

/** Shares voice boundaries across normal, retry and recovery paths without changing nonvoice history. */
export function voiceHistoryItemFilter(
  run: OrchestrationV2Run,
  runs: ReadonlyArray<OrchestrationV2Run>,
): (item: OrchestrationV2TurnItem) => boolean {
  const cutoff = run.voiceHistoryCutoffOrdinal;
  const boundary = voiceHistoryBoundaryOrdinal(run, runs);
  const rolledBack = new Set(
    runs.filter((source) => source.status === "rolled_back").map((source) => source.id),
  );
  return (item) =>
    item.voice === undefined ||
    (cutoff !== undefined &&
      run.freshContext !== true &&
      (item.type === "user_message" || item.type === "assistant_message") &&
      item.messageId !== run.userMessageId &&
      (item.runId === null || !rolledBack.has(item.runId)) &&
      item.ordinal <= cutoff &&
      item.ordinal > boundary);
}

export function voiceHistoryHandoff(input: {
  readonly run: OrchestrationV2Run;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly alreadyDeliveredItemIds?: ReadonlySet<string>;
  readonly nativeInputRunIds?: ReadonlySet<string>;
}): OrchestrationV2ContextHandoff | null {
  const { run, providerThread } = input;
  const eligible = voiceHistoryItemFilter(run, input.runs);
  const runStatuses = new Map(input.runs.map((source) => [source.id, source.status]));
  const messages = input.items
    .filter(eligible)
    .filter(
      (item) =>
        (item.type === "user_message" || item.type === "assistant_message") &&
        item.voice !== undefined &&
        !input.alreadyDeliveredItemIds?.has(item.id) &&
        (item.runId === null || !input.nativeInputRunIds?.has(item.runId)),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .flatMap((item) => {
      const message = historicalMessage(item);
      return message === null
        ? []
        : [
            {
              ...message,
              ...(item.runId === null ? {} : { runStatus: runStatuses.get(item.runId) }),
            },
          ];
    });
  if (messages.length === 0) return null;
  return {
    id: ContextHandoffId.make(`context-handoff:voice:${run.id}`),
    threadId: run.threadId,
    targetRunId: run.id,
    fromProviderThreadIds: [],
    toProviderThreadId: providerThread.id,
    coveredRunOrdinals: { from: run.ordinal, to: run.ordinal },
    strategy: "manual_context",
    status: "ready",
    summaryMessageId: null,
    summaryText: "",
    history: {
      messages,
      coverage: `Recorded voice history through item ordinal ${run.voiceHistoryCutoffOrdinal}; source item and execution identities are preserved. This is conversation, not verified execution.`,
      omittedItems: 0,
    },
    createdByProviderInstanceId: null,
    createdAt: run.requestedAt,
    updatedAt: run.requestedAt,
  };
}
