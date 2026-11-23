import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { selectLiveHistory } from "./liveHistorySelection.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** Same local/fresh-context boundary as the legacy voice surface. No private prompt/tool dump. */
export const readLiveHistory = Effect.fn("LiveHistory.read")(function* (threadId: ThreadId) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const boundary = runs.findLast((run) => run.freshContext);
  const page = yield* threads.getTimelinePage(threadId, {
    view: "messages",
    beforePosition: Number.POSITIVE_INFINITY,
    limit: 32,
  });
  const rows = page.items.flatMap(({ item, sourceThreadId, visibility }) => {
    if (
      sourceThreadId !== threadId ||
      visibility !== "local" ||
      item.threadId !== threadId ||
      (item.type !== "user_message" && item.type !== "assistant_message") ||
      (item.type === "assistant_message" && item.streaming)
    )
      return [];
    const run = item.runId === null ? undefined : byRun.get(item.runId);
    if (item.runId !== null && (!run || run.status === "rolled_back")) return [];
    if (
      boundary &&
      item.messageId !== boundary.userMessageId &&
      ((run && run.ordinal < boundary.ordinal) ||
        (item.voice
          ? item.ordinal <= (boundary.voiceHistoryCutoffOrdinal ?? Infinity)
          : item.runId === null))
    )
      return [];
    return [item];
  });
  const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
    messageRoles: ["user", "assistant"],
    messageIds: [...new Set(rows.map((row) => row.messageId))],
  });
  const byId = new Map(messages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const candidates = rows.flatMap((row) => {
    const message = byId.get(row.messageId);
    if (
      !message ||
      message.threadId !== threadId ||
      message.streaming ||
      message.notification ||
      (message.role !== "user" && message.role !== "assistant") ||
      seen.has(message.id)
    )
      return [];
    seen.add(message.id);
    return [
      {
        role: message.role,
        text: message.text,
        ...(message.voice ? { voice: message.voice } : {}),
      },
    ];
  });
  const selected = selectLiveHistory(candidates);
  return {
    messages: selected,
    runs: runs
      .filter(
        (run) =>
          !["rolled_back", "completed", "failed", "cancelled", "interrupted"].includes(run.status),
      )
      .slice(-8),
  };
});
