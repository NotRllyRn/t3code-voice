import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;

it.layer(layerTest)("ProjectionStoreV2 Voice", (it) => {
  it.effect(
    "pages message-view timelines backward over inherited fork history after source rollback",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
        const projectId = ProjectId.make("project:voice-messages-paging");
        const sourceThreadId = ThreadId.make("thread:voice-messages-paging:source");
        const targetThreadId = ThreadId.make("thread:voice-messages-paging:target");
        const sourceProviderThreadId = ProviderThreadId.make(
          "provider-thread:voice-messages-paging:source",
        );
        const targetProviderThreadId = ProviderThreadId.make(
          "provider-thread:voice-messages-paging:target",
        );
        const sourceRun1Id = RunId.make("run:voice-messages-paging:source:1");
        const sourceRun2Id = RunId.make("run:voice-messages-paging:source:2");

        yield* store.apply({
          id: EventId.make("event:voice-messages-paging:source-thread"),
          type: "thread.created",
          threadId: sourceThreadId,
          occurredAt: now,
          payload: {
            id: sourceThreadId,
            projectId,
            title: "Voice messages paging source",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: sourceProviderThreadId,
            lineage: {
              rootThreadId: sourceThreadId,
              parentThreadId: null,
              relationshipToParent: null,
            },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });

        for (const [runOrdinal, runId] of [
          [1, sourceRun1Id],
          [2, sourceRun2Id],
        ] as const) {
          yield* store.apply({
            id: EventId.make(`event:voice-messages-paging:run:${runOrdinal}`),
            type: "run.created",
            threadId: sourceThreadId,
            runId,
            driver,
            providerInstanceId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId: sourceThreadId,
              ordinal: runOrdinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: sourceProviderThreadId,
              userMessageId: MessageId.make(`msg:voice-messages-paging:user:${runOrdinal}`),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          });
          const baseOrdinal = (runOrdinal - 1) * 2;
          yield* store.apply({
            id: EventId.make(`event:voice-messages-paging:user:${runOrdinal}`),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:voice-messages-paging:user:${runOrdinal}`),
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: baseOrdinal,
              type: "user_message",
              status: "completed",
              title: null,
              messageId: MessageId.make(`msg:voice-messages-paging:user:${runOrdinal}`),
              text: `User ${runOrdinal}`,
              inputIntent: "turn_start",
              createdBy: "user",
              creationSource: "web",
              attachments: [],
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          });
          yield* store.apply({
            id: EventId.make(`event:voice-messages-paging:assistant:${runOrdinal}`),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:voice-messages-paging:assistant:${runOrdinal}`),
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: baseOrdinal + 1,
              type: "assistant_message",
              status: "completed",
              title: null,
              messageId: MessageId.make(`msg:voice-messages-paging:assistant:${runOrdinal}`),
              text: `Assistant ${runOrdinal}`,
              streaming: false,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          });
        }

        yield* store.apply({
          id: EventId.make("event:voice-messages-paging:target-thread"),
          type: "thread.created",
          threadId: targetThreadId,
          occurredAt: now,
          payload: {
            id: targetThreadId,
            projectId,
            title: "Voice messages paging target",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: targetProviderThreadId,
            lineage: {
              rootThreadId: sourceThreadId,
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
            },
            forkedFrom: {
              type: "run",
              threadId: sourceThreadId,
              runId: sourceRun2Id,
            },
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });

        yield* store.apply({
          id: EventId.make("event:voice-messages-paging:source-run2-rollback"),
          type: "run.updated",
          threadId: sourceThreadId,
          runId: sourceRun2Id,
          driver,
          occurredAt: now,
          payload: {
            id: sourceRun2Id,
            threadId: sourceThreadId,
            ordinal: 2,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make("msg:voice-messages-paging:user:2"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });

        const targetAfterRollback = yield* store.getThreadProjection(targetThreadId);
        const latestConversation = yield* store.getTimelinePage(targetThreadId, {
          view: "messages",
          beforePosition: Number.MAX_SAFE_INTEGER,
          limit: 2,
        });
        assert.deepEqual(
          latestConversation.items,
          targetAfterRollback.visibleTurnItems.slice(2, 4),
        );
        assert.isFalse(latestConversation.hasMore);
        assert.isTrue(latestConversation.hasEarlier);

        const earlierConversation = yield* store.getTimelinePage(targetThreadId, {
          view: "messages",
          beforePosition: latestConversation.items[0]!.position,
          limit: 2,
        });
        assert.deepEqual(
          earlierConversation.items,
          targetAfterRollback.visibleTurnItems.slice(0, 2),
        );
        assert.isTrue(earlierConversation.hasMore);
        assert.isFalse(earlierConversation.hasEarlier);
      }),
  );

  it.effect(
    "tracks retired clean-automation runs and orphan thread.created constraints in recovery",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const completedAt = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
        const releasedAt = DateTime.makeUnsafe("2026-09-28T12:05:00.000Z");
        const threadId = ThreadId.make("thread:voice-retired-clean");
        const runId = RunId.make("run:voice-retired-clean:1");
        const retiredRunId = RunId.make("run:voice-retired-clean:2");
        const newerRunId = RunId.make("run:voice-retired-clean:3");

        yield* store.apply({
          id: EventId.make("event:voice-retired-clean:thread"),
          type: "thread.created",
          threadId,
          occurredAt: completedAt,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project:voice-retired-clean"),
            title: "Retired clean recovery",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
            forkedFrom: null,
            createdBy: "user",
            creationSource: "web",
            createdAt: completedAt,
            updatedAt: completedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* store.apply({
          id: EventId.make("event:voice-retired-clean:run-1"),
          type: "run.created",
          threadId,
          runId,
          driver,
          providerInstanceId,
          occurredAt: completedAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: ProviderThreadId.make("provider-thread:voice-retired-clean:1"),
            userMessageId: MessageId.make("message:voice-retired-clean:1"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: completedAt,
            startedAt: completedAt,
            completedAt,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const baseRun = (yield* store.getThreadProjection(threadId)).runs[0]!;
        yield* store.apply({
          id: EventId.make("event:voice-retired-clean:run-3"),
          type: "run.created",
          threadId,
          runId: newerRunId,
          occurredAt: releasedAt,
          payload: {
            ...baseRun,
            id: newerRunId,
            ordinal: 3,
            providerThreadId: ProviderThreadId.make("provider-thread:voice-retired-clean:3"),
            requestedAt: releasedAt,
            startedAt: releasedAt,
            completedAt: releasedAt,
          },
        });
        yield* store.apply({
          id: EventId.make("event:voice-retired-clean:run-2"),
          type: "run.created",
          threadId,
          runId: retiredRunId,
          occurredAt: completedAt,
          payload: {
            ...baseRun,
            id: retiredRunId,
            ordinal: 2,
            providerThreadId: null,
            workspacePreparation: {
              type: "root",
              cleanProviderConstraint: {
                instanceId: providerInstanceId,
                driver: "pi",
                environmentMode: "clean",
              },
            },
          },
        });

        const recovery = yield* store.getRuntimeRecoveryProjection(threadId);
        assert.deepEqual(
          recovery.runs.map((run) => run.id),
          [retiredRunId, newerRunId],
        );
        assert.isFalse(recovery.retiredCleanAutomation);

        const eventSql = yield* SqlClient.SqlClient;
        yield* eventSql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:retired-orphan-claim', 'thread', ${threadId}, 0, 'thread.created', '2026-09-28T12:00:00.000Z',
          'server', ${JSON.stringify({ cleanProviderConstraint: { instanceId: providerInstanceId, driver: "pi", environmentMode: "clean" } })}, '{}', 2
        )`;
        assert.isTrue((yield* store.getRuntimeRecoveryProjection(threadId)).retiredCleanAutomation);
      }),
  );
});
