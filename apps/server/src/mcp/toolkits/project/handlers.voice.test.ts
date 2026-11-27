import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const decodeLaunchInput = Schema.decodeUnknownEffect(
  ProjectToolkit.tools.t3_thread_launch.parametersSchema,
);

it.effect(
  "reports effective inherited scripts and launch guard support with an explicit guarded acknowledgement",
  () =>
    Effect.gen(function* () {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const projectId = ProjectId.make("project:client-target");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus",
      } satisfies ModelSelection;
      const script = {
        id: "setup",
        name: "Setup",
        command: "echo setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      } as const;
      const dependencies = Layer.mergeAll(
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refreshWorkspaceSnapshot: () => Effect.succeed([]),
        }),
        ServerSettings.layerTest({
          defaultProjectScripts: [script],
          fallbackModelSelection: null,
        }),
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          requestNamespace: "client:session-1",
          thread: undefined,
          client: {
            sessionId: "session-1",
            label: "Claude Code",
            access: "full-access",
          },
          issuedAt: 0,
          capabilities: new Set(["orchestration" as const]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => {
            const launch = launched.find((candidate) => candidate.threadId === threadId);
            return Effect.succeed(
              launch === undefined
                ? null
                : ({
                    id: launch.threadId,
                    projectId: launch.projectId,
                    modelSelection: launch.modelSelection,
                    deletedAt: null,
                  } as unknown as OrchestrationV2ThreadShell),
            );
          },
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          checkWorktreeBase: () => Effect.void,
          launch: (launch) => {
            launched.push(launch);
            return Effect.succeed({
              threadId: launch.threadId,
              projection: {
                thread: {
                  id: launch.threadId,
                  projectId: launch.projectId,
                  title: launch.title,
                  modelSelection: launch.modelSelection,
                },
                runs: [],
              },
              resumed: false,
              ...(launch.enforceNoSetupScripts === true ? { enforceNoSetupScripts: true } : {}),
            } as unknown as ThreadLaunch.ThreadLaunchResult);
          },
        }),
        Layer.mock(Project.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({
                    id,
                    workspaceRoot: "/projects/client-target",
                    defaultModelSelection: modelSelection,
                    title: "Project",
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                    deletedAt: null,
                  } as unknown as ProjectRecord)
                : Option.none(),
            ),
          workspaceScanDirectory: Effect.succeed,
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      ).pipe(
        Layer.provideMerge(GitVcsDriver.layer),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-voice-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const read = yield* toolkit
        .handle("t3_project_read", { projectId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(read.at(-1)?.result).toMatchObject({
        scripts: [script],
        effectiveScripts: [script],
        launchCapabilities: { enforceNoSetupScripts: true },
      });
      const result = yield* toolkit
        .handle("t3_thread_launch", { projectId, title: "Guarded", enforceNoSetupScripts: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      expect(launched[0]?.enforceNoSetupScripts).toBe(true);
      expect(result.at(-1)?.result).toMatchObject({ enforceNoSetupScripts: true });
      const retired = yield* decodeLaunchInput({
        projectId,
        title: "Retired",
        cleanProviderConstraint: { instanceId: "old-pi", driver: "pi", environmentMode: "clean" },
      }).pipe(Effect.result);
      expect(retired._tag).toBe("Failure");
    }),
);
