import {
  CommandId,
  ModelSelection,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  resolveProjectProviderInstanceEnabled,
  type ScheduledTask,
  type ScheduledTaskError,
} from "@t3tools/contracts";
import { FORK_RELEASE } from "@t3tools/shared/forkIdentity";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  claimCandidate,
  parseCandidate,
  recordLaunchedThread,
} from "../../../../scripts/voice-upstream-coordinator.ts";
import {
  githubJson,
  type Candidate,
  type GitHubApi,
} from "../../../../scripts/lib/voice-upstream-poll.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const MAX_BODY_BYTES = 1024;

export const VoiceWebhookBinding = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  action: Schema.Literal("voice-upstream-release"),
  launchPolicy: Schema.Literal("configured-codex-v1"),
  taskId: ScheduledTaskId,
  generation: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  projectId: ProjectId,
  managerThreadId: ThreadId,
  stateDir: Schema.String.check(Schema.isMinLength(1)),
});
export type VoiceWebhookBinding = typeof VoiceWebhookBinding.Type;

const decodeBindingJson = Schema.decodeEffect(Schema.fromJsonString(VoiceWebhookBinding));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeModelSelection = Schema.decodeEffect(ModelSelection);

type Prepared = { readonly binding: VoiceWebhookBinding; readonly candidate: Candidate };

export class VoiceWebhookActionError extends Schema.TaggedError<VoiceWebhookActionError>()(
  "VoiceWebhookActionError",
  {
    reason: Schema.Literals(["binding", "body", "provider", "project", "claim", "launch"]),
  },
) {
  override get message() {
    return `Voice webhook action refused: ${this.reason}.`;
  }
}

export class VoiceWebhookBindingSource extends Context.Reference<
  Effect.Effect<VoiceWebhookBinding | null, VoiceWebhookActionError>
>("t3/VoiceWebhookBindingSource", {
  defaultValue: () => Effect.succeed(null),
}) {}

export class VoiceGitHubApi extends Context.Reference<GitHubApi>("t3/VoiceGitHubApi", {
  defaultValue: () => githubJson,
}) {}

export class VoiceWebhookAction extends Context.Service<
  VoiceWebhookAction,
  {
    readonly prepare: (
      task: ScheduledTask,
      body: Uint8Array,
      now: Date,
    ) => Effect.Effect<Prepared, VoiceWebhookActionError>;
    readonly dispatch: (
      prepared: Prepared,
      guard: Effect.Effect<void, ScheduledTaskError>,
    ) => Effect.Effect<void, VoiceWebhookActionError | ScheduledTaskError>;
  }
>()("t3/scheduledTasks/VoiceWebhookAction") {}

export const layerBinding = Layer.effect(
  VoiceWebhookBindingSource,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const file = path.join(config.secretsDir, "voice-webhook-action.json");
    return Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return null;
      const info = yield* fs.lstat(file);
      if (
        info.type !== "File" ||
        (info.mode & 0o077) !== 0 ||
        Option.getOrUndefined(info.uid) !== process.getuid?.() ||
        info.size > 8192n
      )
        return yield* new VoiceWebhookActionError({ reason: "binding" });
      const bytes = yield* fs.readFile(file);
      if (bytes.byteLength > 8192) return yield* new VoiceWebhookActionError({ reason: "binding" });
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => new VoiceWebhookActionError({ reason: "binding" }),
      });
      return yield* decodeBindingJson(text);
    }).pipe(Effect.mapError(() => new VoiceWebhookActionError({ reason: "binding" })));
  }),
);

export const layer = Layer.effect(
  VoiceWebhookAction,
  Effect.gen(function* () {
    const readBinding = yield* VoiceWebhookBindingSource;
    const api = yield* VoiceGitHubApi;
    const projects = yield* ProjectService.ProjectService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const launches = yield* ThreadLaunchService.ThreadLaunchService;

    const requireBinding = Effect.fn("VoiceWebhookAction.requireBinding")(function* (
      expected?: VoiceWebhookBinding,
    ) {
      const binding = yield* readBinding;
      if (
        !binding?.enabled ||
        (expected !== undefined &&
          (binding.action !== expected.action ||
            binding.launchPolicy !== expected.launchPolicy ||
            binding.taskId !== expected.taskId ||
            binding.generation !== expected.generation ||
            binding.projectId !== expected.projectId ||
            binding.managerThreadId !== expected.managerThreadId ||
            binding.stateDir !== expected.stateDir))
      )
        return yield* new VoiceWebhookActionError({ reason: "binding" });
      return binding;
    });
    const prepare = Effect.fn("VoiceWebhookAction.prepare")(function* (
      task: ScheduledTask,
      body: Uint8Array,
      now: Date,
    ) {
      const binding = yield* requireBinding();
      if (
        !task.enabled ||
        task.schedule.type !== "webhook" ||
        task.schedule.action !== binding.action ||
        task.id !== binding.taskId ||
        task.generation !== binding.generation ||
        task.projectId !== binding.projectId ||
        task.threadId !== binding.managerThreadId ||
        task.schedule.signature === null ||
        task.schedule.dedupe !== undefined
      )
        return yield* new VoiceWebhookActionError({ reason: "binding" });
      // Reject bytes before decoding; delivery history and caller-supplied decoded text are not authority.
      if (body.byteLength === 0 || body.byteLength > MAX_BODY_BYTES)
        return yield* new VoiceWebhookActionError({ reason: "body" });
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
        catch: () => new VoiceWebhookActionError({ reason: "body" }),
      });
      const input = yield* decodeJson(text).pipe(
        Effect.mapError(() => new VoiceWebhookActionError({ reason: "body" })),
      );
      const candidate = yield* Effect.try({
        try: () => parseCandidate(input, now),
        catch: () => new VoiceWebhookActionError({ reason: "body" }),
      });
      return { binding, candidate };
    });
    const preflight = Effect.fn("VoiceWebhookAction.preflight")(function* (
      binding: VoiceWebhookBinding,
    ) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => new VoiceWebhookActionError({ reason: "provider" })),
      );
      const project = yield* projects
        .getById(binding.projectId)
        .pipe(Effect.mapError(() => new VoiceWebhookActionError({ reason: "project" })));
      if (
        (yield* managedFolders.isScratchProject(binding.projectId)) ||
        Option.isNone(project) ||
        project.value.scripts.length !== 0 ||
        resolveProjectScripts(settings, project.value).length !== 0 ||
        resolveProjectSettings(settings, binding.projectId).settings.defaultAutoPull !== false ||
        project.value.autoPull === true
      )
        return yield* new VoiceWebhookActionError({ reason: "project" });
      const defaults = resolveProjectSettings(settings, binding.projectId, project.value).settings;
      const selection = defaults.defaultModelSelection;
      if (
        selection == null ||
        !resolveProjectProviderInstanceEnabled(settings, binding.projectId, selection.instanceId)
      )
        return yield* new VoiceWebhookActionError({ reason: "provider" });
      const entry = settings.providerInstances[selection.instanceId];
      const instance = yield* instances.getInstance(selection.instanceId);
      if (
        entry?.driver !== "codex" ||
        entry.enabled === false ||
        !instance?.enabled ||
        instance.driverKind !== "codex"
      )
        return yield* new VoiceWebhookActionError({ reason: "provider" });
      const modelSelection = yield* decodeModelSelection(selection).pipe(
        Effect.mapError(() => new VoiceWebhookActionError({ reason: "provider" })),
      );
      return { project: project.value, modelSelection, runtimeMode: defaults.defaultRuntimeMode };
    });
    const dispatch = Effect.fn("VoiceWebhookAction.dispatch")(function* (
      prepared: Prepared,
      guard: Effect.Effect<void, ScheduledTaskError>,
    ) {
      const binding = yield* requireBinding(prepared.binding);
      yield* guard;
      const { project } = yield* preflight(binding);
      const now = DateTime.toDateUtc(yield* DateTime.now);
      const context = yield* Effect.context<never>();
      const beforeClaim = Effect.gen(function* () {
        yield* requireBinding(binding);
        yield* guard;
        yield* preflight(binding);
        return DateTime.toDateUtc(yield* DateTime.now);
      });
      const request = yield* Effect.tryPromise({
        try: () =>
          claimCandidate(prepared.candidate, {
            stateDir: binding.stateDir,
            authorizedProjectId: binding.projectId,
            project: { id: project.id, scripts: project.scripts, autoPull: false },
            pin: {
              repository: FORK_RELEASE.upstream.repository,
              tag: FORK_RELEASE.upstream.tag,
              commit: FORK_RELEASE.upstream.sha,
            },
            api,
            now,
            beforeClaim: () => Effect.runPromiseWith(context)(beforeClaim),
          }),
        catch: () => new VoiceWebhookActionError({ reason: "claim" }),
      });
      const { modelSelection, runtimeMode } = yield* preflight(binding);
      yield* requireBinding(binding);
      yield* guard;
      const launchNow = DateTime.toDateUtc(yield* DateTime.now);
      yield* Effect.try({
        try: () => parseCandidate(prepared.candidate, launchNow),
        catch: () => new VoiceWebhookActionError({ reason: "body" }),
      });
      const launched = yield* launches
        .launch({
          commandId: CommandId.make(
            `voice-release:${binding.taskId}:${binding.generation}:${prepared.candidate.deliveryId}`,
          ),
          projectId: binding.projectId,
          title: request.title,
          workspaceStrategy: request.workspaceStrategy,
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          enforceNoSetupScripts: true,
          initialMessage: {
            text: request.message,
            attachments: [],
            scheduledTaskId: binding.taskId,
            senderThreadId: binding.managerThreadId,
          },
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(() => new VoiceWebhookActionError({ reason: "launch" })));
      yield* Effect.tryPromise({
        try: () => recordLaunchedThread(binding.stateDir, launched.threadId),
        catch: () => new VoiceWebhookActionError({ reason: "launch" }),
      });
    });
    return VoiceWebhookAction.of({ prepare, dispatch });
  }),
);
