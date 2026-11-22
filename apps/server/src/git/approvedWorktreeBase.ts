import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

export const resolveApprovedWorktreeBase = Effect.fn("resolveApprovedWorktreeBase")(function* (
  git: Pick<GitVcsDriver["Service"], "execute" | "resolveCommit">,
  input: {
    readonly cwd: string;
    readonly branch: string;
    readonly acceptedCommit: string;
  },
  ensureGitCommand: (operation: string, cwd: string) => Effect.Effect<unknown, GitCommandError>,
) {
  const refuse = () =>
    new GitCommandError({
      operation: "approved-worktree-base",
      command: "git",
      cwd: input.cwd,
      detail: "Approved local branch or accepted-source ancestry is invalid.",
    });
  if (
    !/^[a-f0-9]{40}$/.test(input.acceptedCommit) ||
    !input.branch ||
    input.branch.startsWith("-") ||
    input.branch.startsWith("refs/")
  )
    return yield* refuse();
  yield* ensureGitCommand("GitWorkflowService.resolveApprovedWorktreeBase", input.cwd);
  yield* git.execute({
    operation: "approved-worktree-base",
    cwd: input.cwd,
    args: ["check-ref-format", `refs/heads/${input.branch}`],
  });
  const { commitSha } = yield* git.resolveCommit({
    cwd: input.cwd,
    revision: `refs/heads/${input.branch}`,
  });
  const ancestor = yield* git.execute({
    operation: "approved-worktree-base",
    cwd: input.cwd,
    args: ["merge-base", "--is-ancestor", input.acceptedCommit, commitSha],
    allowNonZeroExit: true,
  });
  if (ancestor.exitCode !== 0) return yield* refuse();
  return commitSha;
});
