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
  it.effect("pages message-view timelines backward with MAX_SAFE_INTEGER and earlier cursors", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
      const threadId = ThreadId.make("thread:voice-messages-paging");
      yield* store.apply({
        id: EventId.make("event:voice-messages-paging:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:voice-messages-paging"),
          title: "Voice messages paging",
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
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      for (let index = 0; index < 4; index++) {
        yield* store.apply({
          id: EventId.make(`event:voice-messages-paging:item:${index}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload:
            index % 2 === 0
              ? {
                  id: TurnItemId.make(`item:voice-messages-paging:${index}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: index,
                  type: "user_message",
                  status: "completed",
                  title: null,
                  messageId: MessageId.make(`msg:voice-messages-paging:${index}`),
                  text: `Message ${index}`,
                  inputIntent: "turn_start",
                  createdBy: "user",
                  creationSource: "web",
                  attachments: [],
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                }
              : {
                  id: TurnItemId.make(`item:voice-messages-paging:${index}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: index,
                  type: "assistant_message",
                  status: "completed",
                  title: null,
                  messageId: MessageId.make(`msg:voice-messages-paging:${index}`),
                  text: `Message ${index}`,
                  streaming: false,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
        });
      }

      const projection = yield* store.getThreadProjection(threadId);
      const latestConversation = yield* store.getTimelinePage(threadId, {
        view: "messages",
        beforePosition: Number.MAX_SAFE_INTEGER,
        limit: 2,
      });
      assert.deepEqual(latestConversation.items, projection.visibleTurnItems.slice(2, 4));
      assert.isFalse(latestConversation.hasMore);
      assert.isTrue(latestConversation.hasEarlier);

      const earlierConversation = yield* store.getTimelinePage(threadId, {
        view: "messages",
        beforePosition: latestConversation.items[0]!.position,
        limit: 2,
      });
      assert.deepEqual(earlierConversation.items, projection.visibleTurnItems.slice(0, 2));
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
