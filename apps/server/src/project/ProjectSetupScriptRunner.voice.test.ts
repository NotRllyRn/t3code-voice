import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ProjectId, type TerminalSessionSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const threadId = "thread-1";
const terminalId = "setup-setup";
const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

it.effect.each(["inherited", "override-empty", "changed-project", "unguarded"] as const)(
  "enforces no scripts at execution with %s configuration",
  (mode) =>
    Effect.gen(function* () {
      const id = ProjectId.make("project-guard");
      const script = {
        id: "setup",
        name: "Setup",
        command: "echo setup",
        icon: "configure",
        runOnWorktreeCreate: true,
      } as const;
      const staleProject = {
        id,
        title: "Project",
        workspaceRoot: "/repo",
        scripts: [],
        defaultModelSelection: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      };
      let opened = 0;
      const runner = yield* ProjectSetupScriptRunner.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(TerminalManager.TerminalManager)({
              open: () =>
                Effect.sync(() => {
                  opened++;
                  return openSnapshot("");
                }),
              getShell: () => Effect.succeed("/bin/zsh"),
              subscribe: () => Effect.succeed(() => {}),
              write: () => Effect.void,
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({
                  ...staleProject,
                  scripts: mode === "changed-project" ? [script] : [],
                }),
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed(null),
            }),
            ServerSettings.layerTest({
              defaultProjectScripts: mode === "changed-project" ? [] : [script],
              ...(mode === "override-empty"
                ? {
                    projectSettingsOverrides: { [id]: { defaultProjectScripts: [] } },
                  }
                : {}),
            }),
            NodeCrypto.layer,
          ),
        ),
      );
      const result = yield* runner
        .runForThread({
          threadId,
          projectId: id,
          project: staleProject,
          worktreePath: "/repo/worktree",
          ...(mode === "unguarded" ? {} : { enforceNoSetupScripts: true }),
        })
        .pipe(Effect.result);
      if (mode === "inherited" || mode === "changed-project") {
        expect(Result.isFailure(result)).toBe(true);
        expect(Result.isFailure(result) && result.failure._tag).toBe(
          "ProjectSetupScriptsForbiddenError",
        );
        expect(opened).toBe(0);
      } else {
        expect(Result.isSuccess(result) && result.success.status).toBe(
          mode === "unguarded" ? "started" : "no-script",
        );
        expect(opened).toBe(mode === "unguarded" ? 1 : 0);
      }
    }),
);
