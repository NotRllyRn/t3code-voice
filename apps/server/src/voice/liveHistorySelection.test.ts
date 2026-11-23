import { expect, it } from "vite-plus/test";
import { selectLiveHistory } from "./liveHistorySelection.ts";

it("retains real user intent and coding result when generated speech dominates reconnect history", () => {
  const user = { role: "user", text: "Fix keyboard input" };
  const result = { role: "assistant", text: "Keyboard fix tested; no commit made" };
  const voices = Array.from({ length: 6 }, (_, n) => ({
    role: "assistant",
    text: `Generated ${n}`,
    voice: {},
  }));
  expect(selectLiveHistory([user, result, ...voices])).toEqual([user, result, ...voices.slice(-2)]);
});
it("keeps chronological speaker roles and bounded whole messages", () => {
  const rows = [
    { role: "user", text: "Keep this request" },
    { role: "assistant", text: "界".repeat(12000), voice: {} },
    { role: "assistant", text: "Recent generated reply", voice: {} },
  ];
  expect(selectLiveHistory(rows)).toEqual([rows[0], rows[2]]);
  expect(selectLiveHistory([])).toEqual([]);
});
