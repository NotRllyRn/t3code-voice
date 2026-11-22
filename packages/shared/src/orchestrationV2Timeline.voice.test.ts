import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
} from "./orchestrationV2Timeline.ts";

type VisibilityInput = Parameters<typeof createOrchestrationV2TurnItemVisibility>[0];
const runId = RunId.make("run:voice-timeline-visibility");
const nodeId = NodeId.make("node:voice-timeline-visibility");

describe.each([
  ["point", isOrchestrationV2TurnItemVisible],
  [
    "indexed",
    (input: Parameters<typeof isOrchestrationV2TurnItemVisible>[0]) =>
      createOrchestrationV2TurnItemVisibility(input)(input.item),
  ],
] as const)("%s Voice timeline visibility", (_, isVisible) => {
  it.each([
    { status: "preparing", visible: true },
    { status: "starting", visible: true },
    { status: "running", visible: true },
    { status: "waiting", visible: true },
    { status: "completed", visible: true },
    { status: "interrupted", visible: true },
    { status: "failed", visible: true },
    { status: "queued", visible: true },
    { status: "cancelled", visible: true },
    { status: "rolled_back", visible: false },
  ] satisfies ReadonlyArray<{
    status: VisibilityInput["runs"][number]["status"];
    visible: boolean;
  }>)("retains queued Voice transcripts unless rolled back ($status)", ({ status, visible }) => {
    const item = {
      type: "user_message",
      inputIntent: "queued_turn",
      runId,
      nodeId,
      voice: {
        sessionId: "voice",
        itemId: "input",
        sequence: 1,
        textKind: "final_user_transcript",
        delivery: "unknown",
      },
    } satisfies VisibilityInput["items"][number];
    expect(isVisible({ item, runs: [{ id: runId, status }], attempts: [], items: [item] })).toBe(
      visible,
    );
  });
});
