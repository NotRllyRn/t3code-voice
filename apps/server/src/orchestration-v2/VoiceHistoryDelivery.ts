import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { voiceHistoryBoundaryOrdinal, voiceHistoryHandoff } from "./VoiceHistory.ts";

export const prepareVoiceHistoryHandoffs = Effect.fn("VoiceHistoryDelivery.prepare")(function* <
  PersistError,
>(input: {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly contextHandoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly effectiveHandoffs: Array<OrchestrationV2ContextHandoff>;
  readonly alreadyDeliveredItemIds: ReadonlySet<string>;
  readonly nativeInputRunIds: ReadonlySet<string>;
  readonly legacyInputRunIds: ReadonlySet<string>;
  readonly sameNativeThread: boolean;
  readonly getThreadRecords: ProjectionStoreV2Shape["getThreadRecords"];
  readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
}) {
  const { run } = input;
  if (run.voiceHistoryCutoffOrdinal === undefined) return input.effectiveHandoffs;
  const { turnItems } = yield* input.getThreadRecords(input.threadId, ["turnItems"], {
    voiceHistory: {
      throughOrdinal: run.voiceHistoryCutoffOrdinal,
      afterOrdinal: voiceHistoryBoundaryOrdinal(run, input.runs, input.turnItems),
    },
    turnItemTypes: ["user_message", "assistant_message"],
  });
  const handoff = voiceHistoryHandoff({
    run,
    providerThread: input.providerThread,
    runs: input.runs,
    turnItems: input.turnItems,
    alreadyDeliveredItemIds: input.alreadyDeliveredItemIds,
    nativeInputRunIds: new Set([
      ...input.nativeInputRunIds,
      ...(input.sameNativeThread ? input.legacyInputRunIds : []),
    ]),
    items: turnItems,
  });
  if (handoff === null || input.effectiveHandoffs.some((saved) => saved.id === handoff.id)) {
    return input.effectiveHandoffs;
  }
  const saved = input.contextHandoffs.find((saved) => saved.id === handoff.id);
  if (saved === undefined) yield* input.persist(handoff);
  return [...input.effectiveHandoffs, saved ?? handoff];
});
