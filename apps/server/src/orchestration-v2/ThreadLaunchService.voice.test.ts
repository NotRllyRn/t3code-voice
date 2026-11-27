import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CommandId,
  GitCommandError,
  MessageId,
  OrchestrationV2ThreadProjectionJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:launch-voice-test");
const encodeThreadProjection = Schema.encodeEffect(OrchestrationV2ThreadProjectionJson);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  trackedFolders: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in launch tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const inheritedSetupScript = {
  id: "inherited-setup",
  name: "Inherited setup",
  command: "echo setup",
  icon: "configure",
  runOnWorktreeCreate: true,
} as const;

interface HarnessOptions {
  readonly createWorktree?: GitWorkflow.GitWorkflowService["Service"]["createWorktree"];
  readonly hasCommit?: GitWorkflow.GitWorkflowService["Service"]["hasCommit"];
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly git?: Partial<GitWorkflow.GitWorkflowService["Service"]>;
}

function makeHarness(options: HarnessOptions = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-launch-voice" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(options.serverSettings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const createWorktree = vi.fn(
    options.createWorktree ??
      ((input) =>
        Effect.succeed({
          worktree: { path: "/repo-worktrees/feature", refName: input.newRefName, headSha: "abc" },
        } as never)),
  );
  const runSetup = vi.fn(
    options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const })),
  );
  const layerExternalServices = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(CheckpointStore.CheckpointStore)({ isGitRepository: () => Effect.succeed(true) }),
    Layer.succeed(ProjectService.ProjectService, {
      create: () => Effect.die("unused"),
      bootstrap: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      delete: () => Effect.die("unused"),
      listPage: () => Effect.die("unused"),
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      getByWorkspaceRoot: () => Effect.succeedSome(project),
      workspaceScanDirectory: () => Effect.die("unused"),
      snapshot: Effect.die("unused"),
      getShell: () => Effect.die("unused"),
      listShells: () => Effect.die("unused"),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      repositoryRoot: () => Effect.succeed(project.workspaceRoot),
      createWorktree,
      renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
      fetchWorktreeBaseCommit: () =>
        Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
      hasCommit: options.hasCommit ?? (() => Effect.succeed(false)),
      currentBranch: () => Effect.succeed(null),
      resolveWorktreeBaseRemote: () => Effect.succeed({ remoteName: "origin", branchName: "main" }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      remoteExists: () => Effect.succeed(true),
      remoteBranchExists: () => Effect.succeed(true),
      listLocalBranchNames: () => Effect.succeed([]),
      removeWorktree: () => Effect.void,
      deleteLocalBranch: () => Effect.void,
      ...options.git,
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: runSetup,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
    }),
    layerServerSettings,
    ProviderRegistryMock.layer(),
    Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRegistry,
        layerExternalServices,
        layerThreadManagement,
        layerReceipts,
        layerOrchestrator,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerLaunch,
      layerRegistry,
      layerThreadManagement,
      layerOutbox,
      layerDatabase,
      layerExternalServices,
    ),
    createWorktree,
    runSetup,
  };
}

function launchInput(input: {
  readonly command: string;
  readonly thread: string;
  readonly message?: string;
  readonly workspace: ThreadLaunch.ThreadLaunchInput["workspaceStrategy"];
}) {
  return {
    commandId: CommandId.make(input.command),
    threadId: ThreadId.make(input.thread),
    projectId,
    title: "Launch test",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceStrategy: input.workspace,
    ...(input.message === undefined
      ? {}
      : {
          initialMessage: {
            messageId: MessageId.make(`${input.command}:message`),
            text: input.message,
            attachments: [],
          },
        }),
    createdBy: "user" as const,
    creationSource: "web" as const,
  } satisfies ThreadLaunch.ThreadLaunchInput;
}

const preparationSettled = (threadId: ThreadId, commandPrefix?: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          (commandPrefix === undefined ||
            stored.commandId?.startsWith(`${commandPrefix}:`) === true) &&
          (stored.commandId?.endsWith(":release") === true ||
            stored.event.payload.status === "failed"),
      ),
      Stream.runHead,
    );
    return yield* threads.getThreadProjection(threadId);
  });

it.effect.each([false, true])(
  "guards inherited scripts before launch side effects (empty override: %s)",
  (overrideEmpty) => {
    const harness = makeHarness({
      serverSettings: {
        defaultProjectScripts: [inheritedSetupScript],
        ...(overrideEmpty
          ? { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } } }
          : {}),
      },
    });
    return Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const input = {
        ...launchInput({
          command: "guard:preflight",
          thread: "guard:preflight",
          message: "Guarded",
          workspace: { type: "worktree", baseRef: "main" },
        }),
        enforceNoSetupScripts: true,
      };
      if (overrideEmpty) {
        const result = yield* launches.launch(input);
        yield* preparationSettled(result.threadId);
        assert.equal(result.enforceNoSetupScripts, true);
        assert.equal(harness.runSetup.mock.calls[0]?.[0].enforceNoSetupScripts, true);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const projection = yield* threads.getThreadProjection(result.threadId);
        const encoded = yield* encodeThreadProjection(projection);
        assert.equal(encoded.runs[0]?.workspacePreparation?.enforceNoSetupScripts, true);
      } else {
        const error = yield* launches.launch(input).pipe(Effect.flip);
        assert.equal(error._tag, "ThreadLaunchError");
        assert.equal(harness.createWorktree.mock.calls.length, 0);
        assert.equal(harness.runSetup.mock.calls.length, 0);
        const threads = yield* ThreadManagement.ThreadManagementService;
        assert.isNull(yield* threads.getThreadShell(input.threadId));
      }
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "rejects changed configuration before setup and preserves the guard on durable preparation retry",
  () =>
    Effect.gen(function* () {
      const checkoutStarted = yield* Deferred.make<void>();
      const finishCheckout = yield* Deferred.make<void>();
      const harness = makeHarness({
        createWorktree: (input) =>
          Deferred.succeed(checkoutStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishCheckout)),
            Effect.as({
              worktree: {
                path: "/repo-worktrees/guarded",
                refName: input.newRefName,
                headSha: "abc",
              },
            } as never),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const launched = yield* launches.launch({
          ...launchInput({
            command: "guard:race",
            thread: "guard:race",
            message: "Guarded",
            workspace: { type: "worktree", baseRef: "main" },
          }),
          enforceNoSetupScripts: true,
        });
        yield* Deferred.await(checkoutStarted);
        yield* settings.updateSettings({ defaultProjectScripts: [inheritedSetupScript] });
        yield* Deferred.succeed(finishCheckout, undefined);
        const failed = yield* preparationSettled(launched.threadId);
        assert.equal(failed.runs[0]?.status, "failed");
        assert.equal(harness.runSetup.mock.calls.length, 0);
        yield* launches.retryPreparation({
          commandId: CommandId.make("guard:race:retry-blocked"),
          threadId: launched.threadId,
          runId: failed.runs[0]!.id,
        });
        const blocked = yield* preparationSettled(launched.threadId, "guard:race:retry-blocked");
        assert.equal(blocked.runs[0]?.status, "failed");
        assert.equal(harness.runSetup.mock.calls.length, 0);
        yield* settings.updateSettings({ defaultProjectScripts: [] });
        yield* launches.retryPreparation({
          commandId: CommandId.make("guard:race:retry-clear"),
          threadId: launched.threadId,
          runId: failed.runs[0]!.id,
        });
        const prepared = yield* preparationSettled(launched.threadId, "guard:race:retry-clear");
        assert.notEqual(prepared.runs[0]?.status, "failed");
        assert.equal(harness.runSetup.mock.calls[0]?.[0].enforceNoSetupScripts, true);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("rejects retired clean launches and persisted launch replay", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const constraint = {
      instanceId: modelSelection.instanceId,
      driver: "pi" as const,
      environmentMode: "clean" as const,
    };
    const input = launchInput({
      command: "clean:replay",
      thread: "clean:replay",
      message: "Clean only",
      workspace: { type: "root" },
    });
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: input.commandId,
      threadId: ThreadId.make("clean:replay"),
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
      cleanProviderConstraint: constraint,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
    });
    const replay = yield* launches.launch(input).pipe(Effect.result);
    assert.equal(replay._tag, "Failure");
    const explicit = yield* launches
      .launch({ ...input, cleanProviderConstraint: constraint })
      .pipe(Effect.result);
    assert.equal(explicit._tag, "Failure");
    const unguarded = yield* launches.launch(
      launchInput({
        command: "normal:inherit",
        thread: "normal:inherit",
        message: "Normal",
        workspace: { type: "root" },
      }),
    );
    assert.equal(unguarded.projection.thread.lineage.parentThreadId, null);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each([false, true])(
  "replays server-allocated launch guard acknowledgement accurately (guarded: %s)",
  (guarded) =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const allowSetup = yield* Deferred.make<void>();
      const harness = makeHarness({
        runSetup: () =>
          Deferred.succeed(setupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowSetup)),
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const { threadId: _unused, ...rest } = launchInput({
          command: "command:launch:allocated-retry-voice",
          thread: "unused",
          message: "Only once",
          workspace: {
            type: "worktree",
            baseRef: "main",
            ...(guarded ? { enforceNoSetupScripts: true } : {}),
          },
        });
        const first = yield* launches.launch(rest);
        yield* Deferred.await(setupEntered);
        const retry = yield* launches.launch(rest);
        assert.equal(first.threadId, retry.threadId);
        assert.isFalse(first.resumed);
        assert.isTrue(retry.resumed);
        assert.equal(retry.enforceNoSetupScripts, guarded ? true : undefined);
        if (!guarded) {
          const error = yield* launches
            .launch({ ...rest, enforceNoSetupScripts: true })
            .pipe(Effect.flip);
          assert.include(String(error.cause), "did not durably acknowledge");
        }
        yield* Deferred.succeed(allowSetup, undefined);
        yield* preparationSettled(first.threadId);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each([undefined, false])(
  "recovers guarded preparation when replay omits or clears the guard (%s)",
  (enforceNoSetupScripts) =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const allowSetup = yield* Deferred.make<void>();
      const harness = makeHarness({
        runSetup: () =>
          Deferred.succeed(setupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowSetup)),
            Effect.as({ status: "no-script" as const }),
          ),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const input = launchInput({
          command: "guard:recovery",
          thread: "guard:recovery",
          message: "Recover guarded work",
          workspace: { type: "worktree", baseRef: "main" },
        });
        const { initialMessage, ...threadInput } = input;
        yield* threads.dispatch({
          ...threadInput,
          type: "thread.create",
          branch: null,
          worktreePath: null,
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${input.commandId}:initial-message`),
          threadId: input.threadId,
          messageId: initialMessage!.messageId,
          text: initialMessage!.text,
          attachments: [],
          modelSelection,
          dispatchMode: {
            type: "defer_start",
            workspaceStrategy: { ...input.workspaceStrategy, enforceNoSetupScripts: true },
          },
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
        const seeded = yield* threads.getThreadProjection(input.threadId);
        assert.equal(seeded.runs.length, 1);
        assert.equal(seeded.runs[0]?.status, "preparing");
        assert.equal(seeded.runs[0]?.workspacePreparation?.enforceNoSetupScripts, true);
        assert.equal(harness.runSetup.mock.calls.length, 0);
        const recovered = yield* launches.launch({
          ...input,
          workspaceStrategy: { ...input.workspaceStrategy, enforceNoSetupScripts },
        });
        yield* Deferred.await(setupEntered);
        const preparing = yield* threads.getThreadProjection(recovered.threadId);
        assert.equal(preparing.runs[0]?.status, "preparing");
        assert.equal(harness.runSetup.mock.calls.length, 1);
        assert.equal(harness.runSetup.mock.calls[0]?.[0].enforceNoSetupScripts, true);
        yield* Deferred.succeed(allowSetup, undefined);
        const settled = yield* preparationSettled(recovered.threadId);
        assert.equal(settled.messages.length, 1);
        assert.equal(settled.runs.length, 1);
        assert.equal(settled.runs[0]?.id, seeded.runs[0]?.id);
        assert.equal(settled.runs[0]?.workspacePreparation?.enforceNoSetupScripts, true);
        assert.equal(settled.runs[0]?.status, "starting");
        assert.equal(harness.runSetup.mock.calls.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("rejects a guarded message added to an unguarded idle launch before dispatch", () =>
  Effect.gen(function* () {
    const checkoutStarted = yield* Deferred.make<void>();
    const finishCheckout = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: (input) =>
        Deferred.succeed(checkoutStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishCheckout)),
          Effect.as({
            worktree: {
              path: "/repo-worktrees/unguarded",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = launchInput({
        command: "guard:idle-upgrade",
        thread: "guard:idle-upgrade",
        workspace: { type: "worktree", baseRef: "main" },
      });
      const idle = yield* launches.launch(input);
      yield* Deferred.await(checkoutStarted);
      const replay = yield* launches
        .launch({
          ...input,
          enforceNoSetupScripts: true,
          initialMessage: { text: "Must not be accepted", attachments: [] },
        })
        .pipe(Effect.exit);
      const projection = yield* threads.getThreadProjection(idle.threadId);
      assert.isEmpty(projection.messages);
      assert.isEmpty(projection.runs);
      assert.isTrue(Exit.isFailure(replay));
      if (Exit.isFailure(replay)) {
        assert.include(Cause.pretty(replay.cause), "did not durably acknowledge");
      }
      assert.equal(harness.createWorktree.mock.calls.length, 1);
      assert.equal(harness.runSetup.mock.calls.length, 0);
      yield* Deferred.succeed(finishCheckout, undefined);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each(["deleted", "moved", "missing-commit", "moved-after-checkout", "valid"] as const)(
  "pins approved worktree preparation without fallback (%s)",
  (state) =>
    Effect.gen(function* () {
      const commit = "a".repeat(40);
      let checks = 0;
      const harness = makeHarness({
        hasCommit: ({ refName }) =>
          Effect.succeed(state !== "missing-commit" && refName === commit),
        git: {
          resolveApprovedWorktreeBase: () =>
            checks++ < (state === "moved-after-checkout" ? 2 : 1)
              ? Effect.succeed(commit)
              : state === "deleted"
                ? Effect.fail(
                    new GitCommandError({
                      operation: "approved-base",
                      command: "git",
                      cwd: "/repo",
                      detail: "Missing approved branch.",
                    }),
                  )
                : Effect.succeed(
                    state === "moved" || state === "moved-after-checkout" ? "b".repeat(40) : commit,
                  ),
          resolveWorktreeBaseRemote: () => Effect.die("Pinned launches must not resolve a remote"),
          resolvePrimaryRemoteName: () => Effect.die("Pinned launches must not fall back"),
        },
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const launched = yield* launches.launch(
          launchInput({
            command: `approved:${state}`,
            thread: `approved:${state}`,
            message: "Update",
            workspace: {
              type: "worktree",
              baseRef: commit,
              branch: "update",
              startFromOrigin: false,
              approvedBase: { branch: "release/approved", commit },
            },
          }),
        );
        const projection = yield* preparationSettled(launched.threadId);
        assert.equal(projection.runs[0]?.status, state === "valid" ? "starting" : "failed");
        assert.equal(
          harness.createWorktree.mock.calls.length,
          state === "valid" || state === "moved-after-checkout" ? 1 : 0,
        );
        if (state === "valid") {
          assert.equal(harness.createWorktree.mock.calls[0]?.[0].refName, commit);
          assert.equal(harness.createWorktree.mock.calls[0]?.[0].baseRefName, "release/approved");
        }
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect.each(["deleted", "moved", "valid"] as const)(
  "recovers approved worktree preparation with its persisted pin (%s)",
  (state) =>
    Effect.gen(function* () {
      const commit = "a".repeat(40);
      let checks = 0;
      const harness = makeHarness({
        hasCommit: ({ refName }) => Effect.succeed(refName === commit),
        git: {
          resolveApprovedWorktreeBase: () =>
            checks++ === 0
              ? Effect.succeed(commit)
              : state === "deleted"
                ? Effect.fail(
                    new GitCommandError({
                      operation: "approved-base",
                      command: "git",
                      cwd: "/repo",
                      detail: "Missing approved branch.",
                    }),
                  )
                : Effect.succeed(state === "moved" ? "b".repeat(40) : commit),
          resolveWorktreeBaseRemote: () => Effect.die("Pinned recovery must not fetch"),
          resolvePrimaryRemoteName: () => Effect.die("Pinned recovery must not fall back"),
        },
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const input = launchInput({
          command: `approved:recover:${state}`,
          thread: `approved:recover:${state}`,
          message: "Recover update",
          workspace: {
            type: "worktree",
            baseRef: commit,
            branch: "update",
            startFromOrigin: false,
            approvedBase: { branch: "release/approved", commit },
          },
        });
        const { initialMessage, ...threadInput } = input;
        yield* threads.dispatch({
          ...threadInput,
          type: "thread.create",
          branch: "update",
          worktreePath: "/repo-update",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${input.commandId}:initial-message`),
          threadId: input.threadId,
          messageId: initialMessage!.messageId,
          text: initialMessage!.text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start", workspaceStrategy: input.workspaceStrategy },
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        });
        const seeded = yield* threads.getThreadProjection(input.threadId);
        yield* launches.prepareRun({
          commandId: CommandId.make(`${input.commandId}:prepare`),
          threadId: input.threadId,
          runId: seeded.runs[0]!.id,
        });
        const projection = yield* preparationSettled(input.threadId);
        assert.equal(projection.runs[0]?.status, state === "valid" ? "starting" : "failed");
        assert.deepEqual(projection.runs[0]?.workspacePreparation, input.workspaceStrategy);
        assert.equal(harness.createWorktree.mock.calls.length, 0);
        assert.equal(harness.runSetup.mock.calls.length, state === "valid" ? 1 : 0);
      }).pipe(Effect.provide(harness.layer));
    }),
);
