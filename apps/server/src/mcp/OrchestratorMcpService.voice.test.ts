import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpScheduledTask,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type Project,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";

const encodeScheduledTaskJson = Schema.encodeEffect(
  Schema.fromJsonString(OrchestratorMcpScheduledTask),
);
const decodeScheduledTaskJson = Schema.decodeEffect(
  Schema.fromJsonString(OrchestratorMcpScheduledTask),
);
const decodeUnknownJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("OrchestratorMcpService Voice", () => {
  const projectId = ProjectId.make("project:scheduled");
  const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
    id: ScheduledTaskId.make("scheduled-task:webhook"),
    title: "On push",
    prompt: "Do {{body.instruction}}",
    enabled: true,
    schedule: { type: "webhook", signature: null },
    projectId,
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    webhook: {
      path: "/hooks/scheduled-task/secret",
      url: "https://t3.example/hooks/secret",
      hasSecret: false,
    },
    ...overrides,
  });
  const supervisedClient: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:scheduled"),
    requestNamespace: "client:scheduled",
    thread: undefined,
    client: {
      sessionId: "scheduled",
      label: "Claude Code",
      access: "approval-required",
    },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (
    tasks: ReadonlyArray<ScheduledTask>,
    upserted: Ref.Ref<number>,
    saved: ScheduledTask = tasks[0]!,
  ) =>
    OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolvePrimaryRemoteName: () => Effect.succeed("origin"),
          resolveDefaultBranchName: () => Effect.succeed("main"),
          resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(null),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeedSome({
                id,
                workspaceRoot: "/repo/scheduled",
                defaultModelSelection: saved.modelSelection,
              } as Project),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            list: () => Effect.succeed({ tasks }),
            upsert: () =>
              Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: saved })),
          }),
        ),
      ),
    );

  it.effect(
    "roundtrips scheduled task JSON and preserves generation across list/create/update",
    () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const plain = task({});
        const genA = "a".repeat(32);
        const second = task({
          id: ScheduledTaskId.make("scheduled-task:second"),
          generation: genA,
        });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service([plain, second], upserted)),
        );

        const listedPlain = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        const encodedPlain = yield* encodeScheduledTaskJson(listedPlain.tasks[0]!);
        assert.deepEqual(yield* decodeScheduledTaskJson(encodedPlain), listedPlain.tasks[0]);

        const listedSecond = yield* mcp.listScheduledTasks(supervisedClient, {
          scheduledTaskId: second.id,
        });
        const encodedSecond = yield* encodeScheduledTaskJson(listedSecond.tasks[0]!);
        assert.deepEqual(yield* decodeUnknownJson(encodedSecond), {
          ...listedSecond.tasks[0],
          generation: genA,
        });

        const genB = "b".repeat(32);
        const hook = task({ generation: genB });
        const timer = task({
          schedule: { type: "interval", everyMs: 3_600_000 },
          webhook: undefined,
        });
        const created = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((svc) =>
            svc.scheduleTask(supervisedClient, {
              projectId,
              prompt: hook.prompt,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([hook], upserted)),
        );
        const converted = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((svc) =>
            svc.updateScheduledTask(supervisedClient, {
              scheduledTaskId: timer.id,
              schedule: { type: "webhook" },
            }),
          ),
          Effect.provide(service([timer], upserted, hook)),
        );
        for (const result of [created, converted]) {
          const encoded = yield* encodeScheduledTaskJson(result);
          assert.deepEqual(yield* decodeUnknownJson(encoded), { ...result, generation: genB });
        }
      }),
  );
});
