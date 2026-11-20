// @effect-diagnostics-next-line nodeBuiltinImport:off -- Independently sign synthetic bytes with Node HMAC.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);

const secret = "synthetic-regression-secret";
const bodyText = '{ "message": "café 🗂", "revision": 10 }\n';
const bytes = (text: string) => new TextEncoder().encode(text);
const signature = (body: Uint8Array) =>
  `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;

// Real generic webhook service and SQLite; provider dispatch and unrelated
// scheduler/project services stay synthetic.
const withService = <A, E>(
  databasePath: string,
  use: (input: {
    service: ScheduledTaskService.ScheduledTaskService["Service"];
    launches: Queue.Queue<ThreadLaunchService.ThreadLaunchInput>;
    completed: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const launches = yield* Queue.unbounded<ThreadLaunchService.ThreadLaunchInput>();
      const completed = yield* Deferred.make<void>();
      const dependencies = Layer.mergeAll(
        NodePlatformCrypto.layer,
        Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Queue.offer(launches, input).pipe(
              Effect.as({ threadId: "thread-regression", resumed: false } as never),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/synthetic-projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.succeed(
          ScheduledTaskService.ScheduledTaskWebhookOrigin,
          Effect.succeed({ relayHookBaseUrl: null }),
        ),
        ManagedPolicy.layerTest(),
      );
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (...args) => {
            end(...args);
            if (span.name === "ScheduledTaskService.runWebhookDelivery")
              Deferred.doneUnsafe(completed, Effect.void);
          };
          return span;
        },
      });
      return yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        return yield* use({ service, launches, completed });
      }).pipe(
        Effect.withTracer(tracer),
        Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))),
      );
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: databasePath })))),
  );

it.effect(
  "authenticates exact HMAC bytes before claiming a replay key, which survives closing and reopening SQLite",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "voice-webhook-regression-" });
      const databasePath = path.join(root, "state.sqlite");
      const request = yield* withService(databasePath, ({ service, launches, completed }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(
            yield* decodeUpsert({
              id: "scheduled-task:voice-regression",
              title: "Synthetic signed task",
              prompt: "Review {{body.message}}",
              enabled: true,
              schedule: {
                type: "webhook",
                signature: {
                  header: "x-hub-signature-256",
                  encoding: "hex",
                  prefix: "sha256=",
                  secret,
                },
                dedupe: { replayKey: "{{headers.delivery-id}}" },
              },
              projectId: "project-regression",
              workspaceStrategy: { type: "root" },
              modelSelection: { instanceId: "synthetic-provider", model: "synthetic-model" },
              runtimeMode: "approval-required",
              interactionMode: "default",
            }),
          );
          const valid: ScheduledTaskService.WebhookTriggerRequest = {
            hookId: task.id,
            token: task.webhook!.path.split("/").at(-1)!,
            method: "POST",
            path: `/api/hooks/${task.id}`,
            query: "",
            headers: {
              "content-type": "application/json",
              "delivery-id": "synthetic-delivery-1",
              "x-hub-signature-256": signature(bytes(bodyText)),
            },
            body: bytes(bodyText),
            bodyText,
          };
          // Equivalent JSON has different signed bytes. Keeping bodyText unchanged
          // also catches a verifier accidentally authenticating the decoded field.
          const normalized = JSON.stringify(JSON.parse(bodyText));
          expect(
            yield* service.triggerWebhook({ ...valid, body: bytes(normalized) }),
          ).toMatchObject({ _tag: "rejected_signature" });
          expect(
            yield* service.triggerWebhook({
              ...valid,
              headers: { ...valid.headers, "x-hub-signature-256": signature(bytes(normalized)) },
            }),
          ).toMatchObject({ _tag: "rejected_signature" });
          expect(yield* Queue.size(launches)).toBe(0);
          expect(yield* service.triggerWebhook(valid)).toMatchObject({
            _tag: "accepted",
            outcome: "accepted",
          });
          expect((yield* Queue.take(launches)).initialMessage!.text).toContain("café 🗂");
          yield* Deferred.await(completed);
          expect((yield* service.list()).tasks[0]!.runCount).toBe(1);
          return valid;
        }),
      );
      // withService's scope has disposed both the service and database connection.
      yield* withService(databasePath, ({ service, launches }) =>
        Effect.gen(function* () {
          expect(
            yield* service.triggerWebhook({
              ...request,
              headers: { ...request.headers, "x-hub-signature-256": "sha256=00" },
            }),
          ).toMatchObject({ _tag: "rejected_signature" });
          expect(yield* service.triggerWebhook(request)).toMatchObject({
            _tag: "accepted",
            outcome: "duplicate",
          });
          expect(yield* Queue.size(launches)).toBe(0);
          expect((yield* service.list()).tasks[0]!.runCount).toBe(1);
          const history = (yield* service.listWebhookDeliveries({
            id: ScheduledTaskId.make(request.hookId),
            acceptAnyOutcome: true,
          })).deliveries;
          expect(history.filter((delivery) => delivery.outcome === "accepted")).toMatchObject([
            { signatureVerified: true },
          ]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
