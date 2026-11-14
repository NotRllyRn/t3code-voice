import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { VoiceOwner } from "./voiceOwner";
const state = vi.hoisted(() => ({
  start: vi.fn(async (_value: object, _options?: { readonly signal?: AbortSignal }) => ({
    _tag: "Success" as string,
  })),
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.start }));
import { useQueueVoiceRequest, type VoiceHandoff } from "./useQueueVoiceRequest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it.each(["live", "rerender", "disable", "replace", "reenable", "unmount"])(
  "checks a confirmed handoff after waiting in the real serial lane: %s",
  async (revocation) => {
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    const scheduler = createAtomCommandScheduler();
    const concurrency = { mode: "serial" as const, key: () => "thread" };
    const runtime = Atom.runtime(Layer.empty);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = scheduler.schedule(registry, concurrency, {}, async () => {
      await blocked;
      return AsyncResult.success(undefined);
    });
    const rpcStartTurn = vi.fn();
    const command = createRuntimeCommand(runtime, {
      label: "test.voice-start-turn",
      scheduler,
      concurrency,
      execute: (input: object) => Effect.sync(() => rpcStartTurn(input)),
    });
    state.start.mockReset();
    state.start.mockImplementation((input, options) => command.run(registry, input, options));
    const root = createRoot(document.createElement("div"));
    let mounted = true;
    using _root = {
      [Symbol.dispose]: () => {
        if (mounted) act(() => root.unmount());
      },
    };
    let callback!: (request: VoiceHandoff) => Promise<void>;
    const owner = {
      key: "saved",
      thread: {
        environmentId: "env",
        id: "thread",
        modelSelection: { instanceId: "codex", model: "codex" },
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
    const request = {
      text: "confirmed",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const old = callback;
    const settled = old(request).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rpcStartTurn).not.toHaveBeenCalled();
    const revoked = revocation !== "live" && revocation !== "rerender";
    if (revocation === "rerender") {
      act(() => root.render(<Harness value={{ ...owner, thread: { ...owner.thread } }} />));
    } else if (revocation === "unmount") {
      act(() => root.unmount());
      mounted = false;
    } else if (revocation === "replace") {
      act(() => root.render(<Harness value={{ ...owner, key: "replacement" }} />));
    } else if (revocation !== "live") {
      act(() => root.render(<Harness value={null} />));
      if (revocation === "reenable") act(() => root.render(<Harness value={owner} />));
    }
    release();
    await prior;
    const error = await settled;
    if (revoked) {
      expect(rpcStartTurn).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: expect.stringMatching(/queue|changed/) });
    } else {
      expect(error).toBeNull();
    }
    if (revocation === "reenable") {
      await expect(old(request)).rejects.toThrow(/changed/);
      await callback(request);
    }
    if (revocation === "reenable" || !revoked) {
      expect(rpcStartTurn).toHaveBeenCalledTimes(1);
      expect(rpcStartTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            dispatchMode: "queue",
            commandId: "command",
            message: expect.objectContaining({ messageId: "message" }),
          }),
        }),
      );
    }
  },
);

it("uses only the existing queue dispatch with stable IDs and refuses a stale owner callback", async () => {
  state.start.mockReset();
  state.start.mockResolvedValue({ _tag: "Success" });
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
