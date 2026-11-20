import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("GitWorkflowService", (it) => {
  it.effect("resolves approved branches and refuses stale or ambiguous bases", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const accepted = (yield* driver.resolveCommit({ cwd, revision: "HEAD" })).commitSha;
      yield* driver.execute({
        operation: "test.setupRepo",
        cwd,
        args: ["branch", "release/stale"],
      });
      yield* driver.execute({
        operation: "test.setupRepo",
        cwd,
        args: [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--allow-empty",
          "-m",
          "accepted",
        ],
      });
      const current = (yield* driver.resolveCommit({ cwd, revision: "HEAD" })).commitSha;
      assert.equal(
        yield* workflow.resolveApprovedWorktreeBase({
          cwd,
          branch: "main",
          acceptedCommit: accepted,
        }),
        current,
      );
      for (const branch of ["release/stale", "missing", "main~1", "refs/heads/main", "-bad"]) {
        const refused = yield* workflow
          .resolveApprovedWorktreeBase({ cwd, branch, acceptedCommit: current })
          .pipe(Effect.result);
        assert.equal(refused._tag, "Failure");
      }
      yield* driver.execute({
        operation: "test.setupRepo",
        cwd,
        args: ["branch", "-D", "release/stale"],
      });
      assert.equal(
        (yield* workflow
          .resolveApprovedWorktreeBase({ cwd, branch: "release/stale", acceptedCommit: accepted })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
});
