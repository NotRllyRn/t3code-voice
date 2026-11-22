import type { Project, ProjectId, ThreadId } from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import type { ProjectService } from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import type { ServerSettingsService } from "../serverSettings.ts";
import type {
  ThreadLaunchBaseRefError,
  ThreadLaunchError,
  ThreadLaunchInput,
  ThreadLaunchWorkspaceStrategy,
} from "./ThreadLaunchService.ts";

type PolicyInput = Pick<ThreadLaunchInput, "commandId" | "projectId" | "workspaceStrategy">;

// Capture existing capabilities only. Each call reads current policy at its launch phase.
export function makeVoiceLaunchPolicy({
  getProject,
  getSettings,
  isScratchProject,
  resolveApprovedWorktreeBase,
  mapError,
  baseRefError,
}: {
  readonly getProject: ProjectService["Service"]["getById"];
  readonly getSettings: ServerSettingsService["Service"]["getSettings"];
  readonly isScratchProject: ManagedProjectFolders["Service"]["isScratchProject"];
  readonly resolveApprovedWorktreeBase: GitWorkflowService["Service"]["resolveApprovedWorktreeBase"];
  readonly mapError: (
    input: PolicyInput,
    operation: ThreadLaunchError["operation"],
    threadId?: ThreadId,
  ) => (cause: unknown) => ThreadLaunchError;
  readonly baseRefError: (fields: {
    projectId: ProjectId;
    projectTitle: string;
    workspaceRoot: string;
    baseRef: string;
  }) => ThreadLaunchBaseRefError;
}) {
  const assertNoScripts = Effect.fn("VoiceLaunchPolicy.assertNoScripts")(function* (
    input: PolicyInput,
  ) {
    if (input.workspaceStrategy.enforceNoSetupScripts !== true) return;
    const project = yield* getProject(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const settings = yield* getSettings.pipe(Effect.mapError(mapError(input, "resolve-project")));
    if (resolveProjectScripts(settings, project).length > 0)
      return yield* mapError(
        input,
        "resolve-project",
      )(new ProjectSetupScriptRunner.ProjectSetupScriptsForbiddenError({ projectId: project.id }));
  });

  const checkApprovedBase = Effect.fn("VoiceLaunchPolicy.checkApprovedBase")(function* ({
    projectId,
    strategy,
    isScratch,
    project,
  }: {
    readonly projectId: ProjectId;
    readonly strategy: Extract<ThreadLaunchWorkspaceStrategy, { type: "worktree" }>;
    readonly isScratch: boolean;
    readonly project: Project | undefined;
  }) {
    if (strategy.approvedBase === undefined) return;
    if (
      isScratch ||
      project === undefined ||
      strategy.startFromOrigin !== false ||
      strategy.baseRef !== strategy.approvedBase.commit
    )
      return yield* baseRefError({
        projectId,
        projectTitle: project?.title ?? "",
        workspaceRoot: project?.workspaceRoot ?? "",
        baseRef: strategy.baseRef,
      });
    const resolved = yield* resolveApprovedWorktreeBase({
      cwd: project.workspaceRoot,
      branch: strategy.approvedBase.branch,
      acceptedCommit: strategy.approvedBase.commit,
    }).pipe(
      Effect.mapError(() =>
        baseRefError({
          projectId: project.id,
          projectTitle: project.title,
          workspaceRoot: project.workspaceRoot,
          baseRef: strategy.baseRef,
        }),
      ),
    );
    if (resolved !== strategy.approvedBase.commit)
      return yield* baseRefError({
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        baseRef: strategy.baseRef,
      });
  });

  const checkPinnedBase = Effect.fn("VoiceLaunchPolicy.checkPinnedBase")(function* (
    input: PolicyInput,
    operation: ThreadLaunchError["operation"],
    threadId: ThreadId,
  ) {
    const strategy = input.workspaceStrategy;
    if (strategy.type === "root" || strategy.approvedBase === undefined) return;
    const pin = strategy.approvedBase;
    yield* Effect.gen(function* () {
      const [isScratch, projectOption] = yield* Effect.all(
        [
          isScratchProject(input.projectId),
          getProject(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
        ],
        { concurrency: "unbounded" },
      );
      yield* checkApprovedBase({
        projectId: input.projectId,
        strategy: {
          type: "worktree",
          baseRef: pin.commit,
          approvedBase: pin,
          startFromOrigin: false,
        },
        isScratch,
        project: Option.getOrUndefined(projectOption),
      });
    }).pipe(Effect.mapError(mapError(input, operation, threadId)));
  });

  const normalizeRequest = Effect.fn("VoiceLaunchPolicy.normalizeRequest")(function* (
    request: ThreadLaunchInput,
  ) {
    const normalizedStrategy: ThreadLaunchWorkspaceStrategy =
      request.workspaceStrategy.type === "worktree" &&
      request.workspaceStrategy.approvedBase === undefined &&
      (yield* isScratchProject(request.projectId))
        ? {
            type: "root",
            enforceNoSetupScripts: request.workspaceStrategy.enforceNoSetupScripts,
            cleanProviderConstraint: request.workspaceStrategy.cleanProviderConstraint,
          }
        : request.workspaceStrategy;
    return {
      ...request,
      workspaceStrategy: {
        ...normalizedStrategy,
        ...(request.enforceNoSetupScripts === true ? { enforceNoSetupScripts: true } : {}),
        ...(request.cleanProviderConstraint === undefined
          ? {}
          : { cleanProviderConstraint: request.cleanProviderConstraint }),
      },
    };
  });

  return { assertNoScripts, checkApprovedBase, checkPinnedBase, normalizeRequest };
}
