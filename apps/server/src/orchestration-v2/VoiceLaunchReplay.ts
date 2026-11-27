import type {
  CommandId,
  OrchestrationV2ThreadProjection,
  ProviderCleanStartConstraint,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { OrchestratorV2DispatchResult, OrchestratorV2Shape } from "./Orchestrator.ts";
import type { ThreadLaunchError, ThreadLaunchInput } from "./ThreadLaunchService.ts";

type PolicyInput = Pick<ThreadLaunchInput, "commandId" | "projectId" | "workspaceStrategy">;

type Refuse = (cause: unknown) => ThreadLaunchError;
type ClaimReplay = {
  readonly claimed: OrchestratorV2DispatchResult;
  readonly hasLaunchReceipt: boolean;
  readonly threadId: ThreadId;
  readonly streamStoredEventsFrom: OrchestratorV2Shape["streamStoredEventsFrom"];
  readonly readError: Refuse;
  readonly refuse: Refuse;
};

const missingGuard = "The previous launch did not durably acknowledge the no-setup-scripts guard.";

// These checks share the enclosing launch span, including its existing read/error boundaries.
const assertOrdinaryConstraint = Effect.fnUntraced(function* (
  constraint: ProviderCleanStartConstraint | undefined,
  refuse: Refuse,
) {
  if (constraint !== undefined) {
    return yield* refuse(
      "Clean-provider automation is retired. Start a new ordinary thread explicitly.",
    );
  }
});

const assertOrdinaryClaim = Effect.fnUntraced(function* ({
  claimed,
  reuseExistingThread,
  hasLaunchReceipt,
  threadId,
  streamStoredEventsFrom,
  readError,
  refuse,
}: ClaimReplay & { readonly reuseExistingThread: boolean }) {
  // A claim can survive a crash before its first run; replay must retain its constraint.
  const createdClaim = claimed.storedEvents.find(
    (stored) => stored.event.type === "thread.created",
  );
  const claim =
    createdClaim !== undefined
      ? Option.some(createdClaim)
      : !reuseExistingThread && (claimed.replayed === true || hasLaunchReceipt)
        ? yield* streamStoredEventsFrom({ threadId, eventType: "thread.created" }).pipe(
            Stream.runHead,
            Effect.mapError(readError),
          )
        : Option.none();
  yield* assertOrdinaryConstraint(
    Option.isSome(claim) && claim.value.event.type === "thread.created"
      ? claim.value.event.payload.cleanProviderConstraint
      : undefined,
    refuse,
  );
});

const assertPriorGuard = Effect.fnUntraced(function* ({
  enforceNoSetupScripts,
  hasLaunchReceipt,
  claimed,
  hasMessageReceipt,
  messageCommandId,
  threadId,
  streamStoredEventsFrom,
  readError,
  refuse,
}: ClaimReplay & {
  readonly enforceNoSetupScripts: boolean;
  readonly hasMessageReceipt: boolean;
  readonly messageCommandId: CommandId;
}) {
  if (
    enforceNoSetupScripts &&
    (hasLaunchReceipt || claimed.replayed === true || hasMessageReceipt)
  ) {
    const claimedRun = claimed.storedEvents.find((stored) => stored.event.type === "run.created");
    const priorRun =
      claimedRun !== undefined
        ? Option.some(claimedRun)
        : hasMessageReceipt
          ? yield* streamStoredEventsFrom({ threadId, eventType: "run.created" }).pipe(
              Stream.filter((stored) => stored.commandId === messageCommandId),
              Stream.runHead,
              Effect.mapError(readError),
            )
          : Option.none();
    if (
      Option.isNone(priorRun) ||
      priorRun.value.event.type !== "run.created" ||
      priorRun.value.event.payload.workspacePreparation?.enforceNoSetupScripts !== true
    ) {
      return yield* refuse(missingGuard);
    }
  }
});

const assertPreparationGuard = Effect.fnUntraced(function* (
  guardRequired: boolean,
  runs: OrchestrationV2ThreadProjection["runs"],
  runId: RunId | null,
  refuse: Refuse,
) {
  if (
    guardRequired &&
    !runs.some(
      (run) => run.id === runId && run.workspacePreparation?.enforceNoSetupScripts === true,
    )
  ) {
    return yield* refuse(missingGuard);
  }
});

export function makeVoiceLaunchReplay({
  threads,
  mapError,
}: {
  readonly threads: Pick<OrchestratorV2Shape, "streamStoredEventsFrom" | "getThreadRecords">;
  readonly mapError: (
    input: PolicyInput,
    operation: ThreadLaunchError["operation"],
    threadId?: ThreadId,
  ) => (cause: unknown) => ThreadLaunchError;
}) {
  const assertClaim = Effect.fnUntraced(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
    claimed: OrchestratorV2DispatchResult,
    hasLaunchReceipt: boolean,
  ) {
    yield* assertOrdinaryClaim({
      claimed,
      reuseExistingThread: input.reuseExistingThread === true,
      hasLaunchReceipt,
      threadId,
      streamStoredEventsFrom: threads.streamStoredEventsFrom,
      readError: mapError(input, "read-receipt", threadId),
      refuse: mapError(input, "resolve-project", threadId),
    });
  });

  const assertInitialMessageGuard = Effect.fnUntraced(function* (
    input: PolicyInput,
    threadId: ThreadId,
    claimed: OrchestratorV2DispatchResult,
    hasLaunchReceipt: boolean,
    hasMessageReceipt: boolean,
    messageCommandId: CommandId,
  ) {
    yield* assertPriorGuard({
      enforceNoSetupScripts: input.workspaceStrategy.enforceNoSetupScripts === true,
      hasLaunchReceipt,
      claimed,
      hasMessageReceipt,
      messageCommandId,
      threadId,
      streamStoredEventsFrom: threads.streamStoredEventsFrom,
      readError: mapError(input, "read-receipt", threadId),
      refuse: mapError(input, "resolve-project", threadId),
    });
  });

  const assertPreparation = Effect.fnUntraced(function* (
    input: PolicyInput,
    threadId: ThreadId,
    runId: RunId | null,
    replayed: boolean,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs"], { runIds: runId === null ? [] : [runId] })
      .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
    const refuse = mapError(input, "resolve-project", threadId);
    yield* assertPreparationGuard(
      input.workspaceStrategy.enforceNoSetupScripts === true && replayed,
      records.runs,
      runId,
      refuse,
    );
    const preparationRun = records.runs.find((run) => run.id === runId);
    yield* assertOrdinaryConstraint(
      preparationRun?.workspacePreparation?.cleanProviderConstraint,
      refuse,
    );
  });

  return { assertClaim, assertInitialMessageGuard, assertPreparation };
}
