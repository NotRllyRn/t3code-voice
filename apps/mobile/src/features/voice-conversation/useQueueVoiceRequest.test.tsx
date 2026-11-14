import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { VoiceOwner } from "./voiceOwner";
const state = vi.hoisted(() => ({ start: vi.fn(async (_value: object) => ({ _tag: "Success" })) }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.start }));
import { useQueueVoiceRequest, type VoiceHandoff } from "./useQueueVoiceRequest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("uses only the existing queue dispatch with stable IDs and refuses a stale owner callback", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  let callback: ((request: VoiceHandoff) => Promise<void>) | undefined;
  const owner = {
    key: "saved",
    thread: {
      environmentId: "env",
      id: "thread",
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: {
        instanceId: "custom-codex",
        model: "codex",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    },
  } as unknown as VoiceOwner;
  function Harness({ value }: { value: VoiceOwner | null }) {
    const queue = useQueueVoiceRequest(value);
    useLayoutEffect(() => {
      callback = queue;
    }, [queue]);
    return null;
  }
  act(() => root.render(<Harness value={owner} />));
  const old = callback!;
  const request = {
    text: "reviewed request",
    commandId: "command",
    messageId: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  state.start.mockRejectedValueOnce(new Error("lost ack"));
  await expect(old(request)).rejects.toThrow(/lost ack/);
  await old(request);
  expect(state.start.mock.calls[0]![0]).toEqual(state.start.mock.calls[1]![0]);
  expect(state.start.mock.calls[1]![0]).toEqual({
    environmentId: "env",
    input: {
      threadId: "thread",
      commandId: "command",
      createdAt: request.createdAt,
      creationSource: "mobile",
      dispatchMode: "queue",
      resendAfterSocketLoss: false,
      modelSelection: owner.thread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      message: { messageId: "message", role: "user", text: "reviewed request", attachments: [] },
    },
  });
  act(() => root.render(<Harness value={null} />));
  await expect(old(request)).rejects.toThrow(/changed/);
  expect(state.start).toHaveBeenCalledTimes(2);
});
