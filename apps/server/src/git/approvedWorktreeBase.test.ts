import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveApprovedWorktreeBase } from "./approvedWorktreeBase.ts";

it.effect.each([
  { branch: "main", acceptedCommit: "a".repeat(39) },
  { branch: "main", acceptedCommit: "A".repeat(40) },
  { branch: "main", acceptedCommit: "HEAD" },
  { branch: "", acceptedCommit: "a".repeat(40) },
  { branch: "-main", acceptedCommit: "a".repeat(40) },
  { branch: "refs/heads/main", acceptedCommit: "a".repeat(40) },
])("rejects invalid approved input before registry or Git: %j", (input) =>
  Effect.gen(function* () {
    const error = yield* resolveApprovedWorktreeBase(
      {
        execute: () => Effect.die("Invalid input reached Git"),
        resolveCommit: () => Effect.die("Invalid input reached ref resolution"),
      },
      { cwd: "/repo", ...input },
      () => Effect.die("Invalid input reached the registry"),
    ).pipe(Effect.flip);
    assert.instanceOf(error, GitCommandError);
    assert.deepInclude(error, {
      operation: "approved-worktree-base",
      command: "git",
      cwd: "/repo",
      detail: "Approved local branch or accepted-source ancestry is invalid.",
    });
  }),
);
