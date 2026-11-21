#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { authorize } from "./lib/local-release-auth.mjs";
import { digest, initialState, tick, validateConfig } from "./lib/local-release-poller.mjs";
import {
  githubApi,
  readAuthorization,
  readJson,
  saveJson,
  runLocked,
  mcpSession,
} from "./lib/local-release-io.mjs";

const [mode, configPath, ...rest] = process.argv.slice(2);
if (
  !["once", "watch", "dry-run", "status", "check", "authorize"].includes(mode) ||
  !configPath ||
  (mode === "authorize" ? rest.length !== 1 : rest.length !== 0)
) {
  console.error(
    "Usage: node scripts/local-release-poller.mjs <check|dry-run|once|watch|status> <config.json>\n       node scripts/local-release-poller.mjs authorize <config.json> <private-pairing-file>",
  );
  process.exitCode = 2;
} else {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
async function main() {
  const c = validateConfig(JSON.parse(await NodeFSP.readFile(configPath, "utf8")));
  for (const key of ["authorizationFile", "stateFile"])
    c[key] = NodePath.resolve(NodePath.dirname(NodePath.resolve(configPath)), c[key]);
  if (mode === "authorize") {
    const expires = await authorize(c.endpoint, rest[0], c.authorizationFile);
    console.log(
      `Authorization saved privately; expires in ${expires} seconds. Delete the consumed pairing file.`,
    );
    return;
  }
  if (mode === "status") {
    console.log(JSON.stringify(await readJson(c.stateFile), null, 2));
    return;
  }
  if (["once", "watch"].includes(mode) && process.env.LOCAL_RELEASE_POLLER_LOCK !== c.stateFile) {
    process.exitCode = await runLocked(c.stateFile, [
      NodePath.resolve(process.argv[1]),
      mode,
      NodePath.resolve(configPath),
    ]);
    return;
  }
  const authorization = await readAuthorization(c.authorizationFile);
  const authHash = digest(authorization);
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  try {
    do {
      let mcp;
      try {
        mcp = await mcpSession(c.endpoint, authorization);
        if (mode === "check") {
          const result = await mcp.call("t3_project_read", { projectId: c.projectId });
          if (!result) throw new Error("Project is unavailable");
          await githubApi(`/repos/${c.fork}`);
          await githubApi(`/repos/${c.upstream}/releases/latest`);
          console.log("GitHub and T3 project access passed (read-only)");
          return;
        }
        const saved = await readJson(c.stateFile);
        if (!saved && mode !== "dry-run") {
          const prs = await githubApi(`/repos/${c.fork}/pulls?state=open&per_page=100`);
          if (prs.some((pr) => pr.head?.ref?.startsWith("upgrade/upstream-")))
            throw new Error(
              "Existing upgrade PR found without local state; restore its state before starting",
            );
        }
        const state = saved ?? initialState(c, authHash);
        const result = await tick(
          c,
          state,
          { authHash, api: githubApi, call: mcp.call, save: (s) => saveJson(c.stateFile, s) },
          { dryRun: mode === "dry-run" },
        );
        console.log(`${new Date().toISOString()} ${result}`);
      } catch (error) {
        if (mode !== "watch") throw error;
        console.error(`${new Date().toISOString()} ${error.message}`);
      } finally {
        await mcp?.close();
      }
      if (mode !== "watch" || stop.signal.aborted) break;
      try {
        await NodeTimersPromises.setTimeout(c.intervalSeconds * 1000, undefined, {
          signal: stop.signal,
        });
      } catch {
        break;
      }
    } while (!stop.signal.aborted);
  } finally {
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
  }
}
