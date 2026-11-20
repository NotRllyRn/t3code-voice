// @effect-diagnostics nodeBuiltinImport:off -- Executes the workflow's preflight with offline GitHub fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { expect, test } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

test("artifact build requires enabled configuration and the exact merged PR identity", async () => {
  const workflow = await NodeFSP.readFile(
    new URL("../.github/workflows/voice-build.yml", import.meta.url),
    "utf8",
  );
  const script =
    /      - name: Verify enabled build and merged PR identity[\s\S]*?        run: \|\n([\s\S]*?)\n  linux:/
      .exec(workflow)![1]!
      .split("\n")
      .map((line) => line.replace(/^          /, ""))
      .join("\n");
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "voice-build-policy-"));
  try {
    await NodeFSP.writeFile(NodePath.join(dir, "gh"), '#!/bin/sh\ncat "$FIXTURE_PR"\n', {
      mode: 0o700,
    });
    const sha = "a".repeat(40),
      head = "b".repeat(40);
    const pr = {
      number: 7,
      merged: true,
      merge_commit_sha: sha,
      head: { sha: head, repo: { full_name: "NotRllyRn/t3code-voice" } },
      base: { ref: "release/voice", repo: { full_name: "NotRllyRn/t3code-voice" } },
    };
    const env = {
      PATH: `${dir}:${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
      BUILD_ENABLED: "true",
      BASE_BRANCH: "release/voice",
      SOURCE_SHA: sha,
      PR_NUMBER: "7",
      REVIEWED_HEAD: head,
      GITHUB_REPOSITORY: "NotRllyRn/t3code-voice",
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: NodePath.join(dir, "outputs"),
      FIXTURE_PR: NodePath.join(dir, "fixture.json"),
    };
    await NodeFSP.writeFile(env.FIXTURE_PR, JSON.stringify(pr));
    await execFile("/bin/bash", ["-c", script], { env });
    expect(await NodeFSP.readFile(env.GITHUB_OUTPUT, "utf8")).toBe(
      "enabled=true\nbase=release/voice\n",
    );
    for (const changed of [
      { merged: false },
      { number: 8 },
      { merge_commit_sha: head },
      { head: { ...pr.head, sha } },
      { head: { ...pr.head, repo: { full_name: "other/fork" } } },
      { base: { ...pr.base, ref: "main" } },
    ]) {
      await NodeFSP.writeFile(env.FIXTURE_PR, JSON.stringify({ ...pr, ...changed }));
      await expect(execFile("/bin/bash", ["-c", script], { env })).rejects.toThrow();
    }
    await NodeFSP.writeFile(env.FIXTURE_PR, JSON.stringify(pr));
    for (const changed of [
      { BASE_BRANCH: "" },
      { BASE_BRANCH: "bad\nbranch" },
      { SOURCE_SHA: "main" },
      { REVIEWED_HEAD: "HEAD" },
      { PR_NUMBER: "7;false" },
    ])
      await expect(
        execFile("/bin/bash", ["-c", script], { env: { ...env, ...changed } }),
      ).rejects.toThrow();
    await NodeFSP.unlink(env.GITHUB_OUTPUT);
    await NodeFSP.unlink(env.FIXTURE_PR);
    for (const enabled of ["", "false"]) {
      await execFile("/bin/bash", ["-c", script], { env: { ...env, BUILD_ENABLED: enabled } });
      await expect(NodeFSP.access(env.GITHUB_OUTPUT)).rejects.toThrow();
    }
    for (const match of workflow.matchAll(/        run: \|\n((?: {10}[^\n]*\n|\n)+)/g)) {
      const shell = match[1]!
        .split("\n")
        .map((line) => line.replace(/^          /, ""))
        .join("\n");
      const file = NodePath.join(dir, "syntax.sh");
      await NodeFSP.writeFile(file, shell);
      await execFile("/bin/bash", ["-n", file]);
    }
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
