import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
// Holds model-selection planning until both racing commands have read no receipt.
let capabilityGate: Effect.Effect<void> | undefined;
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () =>
    (capabilityGate ?? Effect.void).pipe(Effect.as(CodexProviderCapabilitiesV2)),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "receipt-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect(
  "selection precondition rejects a stale send under lock before promoting queued work; receipts still replay",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:selection-admission-race");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("selection-create"),
        threadId,
        projectId: ProjectId.make("project:receipt-race"),
        title: "Selection admission",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const original = (yield* projections.getThreadShell(threadId))!.modelSelection;
      const queued = {
        type: "message.dispatch",
        commandId: CommandId.make("selection-queued"),
        threadId,
        messageId: MessageId.make("selection-queued"),
        text: "Inspect only.",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "server",
      } as const;
      yield* orchestrator.dispatch({
        ...queued,
        commandId: CommandId.make("selection-active"),
        messageId: MessageId.make("selection-active"),
      });
      const receipt = yield* orchestrator.dispatch(queued, { expectedModelSelection: original });
      const initial = yield* projections.getThreadRecords(threadId, ["runs"]);
      assert.deepEqual(
        initial.runs.map((run) => run.status),
        ["preparing", "queued"],
      );
      const active = initial.runs[0]!;
      yield* projections.apply({
        id: EventId.make("selection-ended"),
        type: "run.updated",
        threadId,
        occurredAt: yield* DateTime.now,
        payload: { ...active, status: "completed" },
      });
      const before = yield* projections.getThreadRecords(threadId, ["runs"]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      capabilityGate = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const switching = yield* orchestrator
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("selection-change"),
          threadId,
          modelSelection: { ...modelSelection, model: "gpt-6" },
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const stale = yield* orchestrator
        .dispatch(
          {
            ...queued,
            commandId: CommandId.make("selection-stale"),
            messageId: MessageId.make("selection-stale"),
            dispatchMode: { type: "queue_after_active" },
          },
          { expectedModelSelection: original },
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(switching);
      capabilityGate = undefined;
      const result = yield* Fiber.join(stale);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(result.failure._tag, "OrchestratorInputChangedError");
      const after = yield* projections.getThreadRecords(threadId, ["runs", "messages"]);
      assert.deepEqual(
        after.runs.map((run) => [run.id, run.status]),
        before.runs.map((run) => [run.id, run.status]),
      );
      assert.deepEqual(
        after.messages.map((message) => message.id),
        [MessageId.make("selection-active"), queued.messageId],
      );
      const replay = yield* orchestrator.dispatch(queued, { expectedModelSelection: original });
      assert.isTrue(replay.replayed);
      assert.equal(replay.sequence, receipt.sequence);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          capabilityGate = undefined;
        }),
      ),
      Effect.scoped,
      Effect.provide(layerTest),
    ),
);
