#!/usr/bin/env node

import * as NodeFSP from "node:fs/promises";
import { FORK_RELEASE } from "../packages/shared/src/forkIdentity.ts";
import { githubJson, pollUpstream, postCandidate } from "./lib/voice-upstream-poll.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const send = args.at(-1) === "--enable-webhook";
  const inputs = send ? args.slice(0, -1) : args;
  if (inputs.length !== 0 && (inputs.length !== 2 || inputs[0] !== "--pin" || !inputs[1]))
    throw new Error(
      "Usage: node scripts/voice-upstream-poll.ts [--pin <accepted-pin.json>] [--enable-webhook]",
    );
  const pin: unknown =
    inputs.length === 2
      ? JSON.parse(await NodeFSP.readFile(inputs[1]!, "utf8"))
      : {
          repository: FORK_RELEASE.upstream.repository,
          tag: FORK_RELEASE.upstream.tag,
          commit: FORK_RELEASE.upstream.sha,
        };
  const candidate = await pollUpstream(pin, githubJson);
  if (!candidate) {
    console.log("No new stable upstream release");
    return;
  }
  if (send) {
    await postCandidate(
      candidate,
      process.env.VOICE_UPSTREAM_WEBHOOK_URL ?? "",
      process.env.VOICE_UPSTREAM_WEBHOOK_SECRET ?? "",
    );
    console.log(`Notified coordinator of ${candidate.tag} (${candidate.sha})`);
  } else {
    console.log(JSON.stringify(candidate));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Poll failed");
  process.exitCode = 1;
});
