import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadLaunchBaseRefError, ThreadLaunchError } from "./ThreadLaunchService.ts";
import { makeVoiceLaunchPolicy } from "./VoiceLaunchPolicy.ts";

it.effect.each(["provision-worktree", "release-run"] as const)(
  "checks current project and pin once per %s adapter call, retaining error labels",
  (operation) =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:approved-base");
      const commandId = CommandId.make("command:approved-base");
      const threadId = ThreadId.make("thread:approved-base");
      const commit = "a".repeat(40);
      let projectReads = 0;
      let scratchReads = 0;
      let pinReads = 0;
      const policy = makeVoiceLaunchPolicy({
        getProject: (id) =>
          Effect.sync(() => {
            assert.equal(id, projectId);
            projectReads++;
            return Option.some({
              id,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            });
          }),
        getSettings: Effect.die("Pin adapters must not read settings"),
        isScratchProject: () =>
          Effect.sync(() => {
            scratchReads++;
            return false;
          }),
        resolveApprovedWorktreeBase: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, {
              cwd: "/repo",
              branch: "release/approved",
              acceptedCommit: commit,
            });
            return ++pinReads === 1 ? commit : "b".repeat(40);
          }),
        mapError: (input, phase, id) => (cause) =>
          new ThreadLaunchError({
            commandId: input.commandId,
            projectId: input.projectId,
            operation: phase,
            threadId: id,
            cause,
          }),
        baseRefError: (fields) => new ThreadLaunchBaseRefError(fields),
      });
      const input = {
        projectId,
        commandId,
        workspaceStrategy: {
          type: "existing_worktree" as const,
          worktreePath: "/prepared",
          branch: "prepared",
          approvedBase: { branch: "release/approved", commit },
        },
      };
      yield* policy.checkPinnedBase(input, operation, threadId);
      const error = yield* policy.checkPinnedBase(input, operation, threadId).pipe(Effect.flip);
      assert.instanceOf(error, ThreadLaunchError);
      assert.deepInclude(error, { operation, commandId, projectId, threadId });
      assert.instanceOf(error.cause, ThreadLaunchBaseRefError);
      assert.deepEqual([projectReads, scratchReads, pinReads], [2, 2, 2]);
      for (const workspaceStrategy of [
        { type: "root" as const },
        { type: "worktree" as const, baseRef: "main" },
        { type: "existing_worktree" as const, worktreePath: "/prepared" },
      ]) {
        yield* policy.checkPinnedBase({ ...input, workspaceStrategy }, operation, threadId);
      }
      assert.deepEqual([projectReads, scratchReads, pinReads], [2, 2, 2]);
    }),
);
