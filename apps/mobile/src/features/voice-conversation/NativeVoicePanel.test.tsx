import type { VoiceDependencies, VoiceState } from "@t3tools/client-runtime/voice-conversation";
import * as Option from "effect/Option";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { voiceOwner, type VoiceOwner } from "./voiceOwner";

const state = vi.hoisted(() => ({
  focused: true,
  platform: "ios",
  available: true,
  appState: undefined as undefined | ((state: string) => void),
  confirm: undefined as undefined | (() => void),
  controllers: [] as {
    start: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    mute: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    deps: VoiceDependencies;
  }[],
  uuid: 0,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => state.focused }));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  AppState: {
    currentState: "active",
    addEventListener: (_: string, listener: (state: string) => void) => {
      state.appState = listener;
      return { remove: vi.fn() };
    },
  },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <textarea
      value={value}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (_: string, _text: string, buttons: { onPress: () => void }[]) => {
    state.confirm = buttons[1]!.onPress;
  },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `uuid-${++state.uuid}` }));
vi.mock("../../native/nativeWebSocket", () => ({
  voiceSocketAvailable: true,
  createVoiceSocket: vi.fn(),
}));
vi.mock("../../native/voiceConversation", () => ({
  get nativeVoiceAvailable() {
    return state.available;
  },
  createNativeVoiceMedia: vi.fn(),
  prepareVoiceCrypto: vi.fn(),
}));
vi.mock("../../state/session", () => ({ usePreparedConnection: () => prepared }));
vi.mock("../voice-input/voiceDestination", () => ({
  runSpeech: vi.fn(async () => "wss://relay.invalid/voice?wsTicket=ticket"),
}));
vi.mock("@t3tools/client-runtime/voice-conversation", async (original) => {
  const actual = await original<typeof import("@t3tools/client-runtime/voice-conversation")>();
  return {
    ...actual,
    VoiceController: vi.fn(function (
      deps: VoiceDependencies,
      publish: (state: VoiceState) => void,
    ) {
      const controller = {
        deps,
        start: vi.fn(async () =>
          publish({ ...actual.INITIAL_VOICE_STATE, phase: "active", transcript: "review this" }),
        ),
        record: vi.fn(() =>
          publish({ ...actual.INITIAL_VOICE_STATE, phase: "active", recording: true }),
        ),
        finish: vi.fn(() => publish({ ...actual.INITIAL_VOICE_STATE, phase: "active" })),
        mute: vi.fn(),
        interrupt: vi.fn(),
        stop: vi.fn(),
        dispose: vi.fn(),
      };
      state.controllers.push(controller);
      return controller;
    }),
  };
});
import { NativeVoicePanel } from "./NativeVoicePanel";
const prepared = Option.some({});
const owner = {
  key: "owner",
  thread: {
    environmentId: "env",
    id: "thread",
    providerInstanceId: "custom-codex",
    modelSelection: { instanceId: "custom-codex", model: "codex-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    archivedAt: null,
  },
} as VoiceOwner;
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  state.controllers = [];
  state.focused = true;
  state.platform = "ios";
  state.available = true;
  state.confirm = undefined;
});
function render() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onQueue = vi.fn(async (_request: object) => {});
  const update = (key = "owner", disabled = false, providerEnabled = true) =>
    act(() => {
      const eligible = voiceOwner({
        thread: owner.thread,
        effectiveModel: owner.thread.modelSelection,
        driver: "codex",
        providerEnabled,
        ready: true,
      });
      root.render(
        eligible ? (
          <NativeVoicePanel owner={{ ...eligible, key }} disabled={disabled} onQueue={onQueue} />
        ) : null,
      );
    });
  update();
  unmount = () => act(() => root.unmount());
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const text = (value: string) =>
    act(() => {
      const input = container.querySelector("textarea")!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  return { container, onQueue, update, button, click, text };
}

const androidBuild = process.env.T3_MOBILE_TEST_PLATFORM === "android";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it.runIf(androidBuild)("hides native conversation voice in the Android build", () => {
  const view = render();
  expect(view.container.textContent).toBe("");
});
describe.skipIf(androidBuild)("native voice panel", () => {
  it("uses the shared controller for push to talk and explicit audio controls only", async () => {
    const view = render();
    await view.click("Voice conversation");
    const controller = state.controllers[0]!;
    await view.click("Start voice");
    await view.click("Record turn");
    await view.click("Send voice turn");
    await view.click("Mute mic");
    await view.click("Interrupt voice");
    await view.click("Stop voice");
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.record).toHaveBeenCalledTimes(1);
    expect(controller.finish).toHaveBeenCalledTimes(1);
    expect(controller.mute).toHaveBeenCalledTimes(1);
    expect(controller.interrupt).toHaveBeenCalledTimes(1);
    expect(controller.stop).toHaveBeenCalled();
    expect(view.onQueue).not.toHaveBeenCalled();
    expect(await controller.deps.url(new AbortController().signal)).toBe(
      "wss://relay.invalid/voice?wsTicket=ticket&threadId=thread",
    );
  });
  it("requires confirmation, rejects duplicate taps, and preserves IDs on unchanged retry", async () => {
    const view = render();
    view.onQueue.mockRejectedValueOnce(new Error("lost ack"));
    await view.click("Voice conversation");
    view.text("a coding request");
    await view.click("Review and queue request");
    await view.click("Review and queue request");
    expect(view.onQueue).not.toHaveBeenCalled();
    await act(async () => state.confirm?.());
    const first = view.onQueue.mock.calls[0]![0];
    await view.click("Retry confirmed queue request");
    await act(async () => state.confirm?.());
    expect(view.onQueue.mock.calls[1]![0]).toEqual(first);
    expect(view.container.textContent).toContain("Queued. Check the thread");
    expect(state.controllers[0]!.interrupt).not.toHaveBeenCalled();
  });
  it("allocates new retry IDs after an edit and revokes confirmation when disabled", async () => {
    const view = render();
    view.onQueue.mockRejectedValueOnce(new Error("lost ack"));
    await view.click("Voice conversation");
    view.text("first request");
    await view.click("Review and queue request");
    await act(async () => {
      state.confirm?.();
      state.confirm?.();
    });
    expect(view.onQueue).toHaveBeenCalledTimes(1);
    const first = view.onQueue.mock.calls[0]![0];
    view.text("edited request");
    await view.click("Review and queue request");
    await act(async () => state.confirm?.());
    expect(view.onQueue).toHaveBeenCalledTimes(2);
    expect(view.onQueue.mock.calls[1]![0]).not.toEqual(first);
    view.text("another request");
    await view.click("Review and queue request");
    view.update("owner", true);
    await act(async () => state.confirm?.());
    expect(view.onQueue).toHaveBeenCalledTimes(2);
    expect(state.controllers[0]!.stop).toHaveBeenCalled();
  });
  it("invalidates confirmation on edit and invalidates all context on owner change", async () => {
    const view = render();
    await view.click("Voice conversation");
    view.text("first");
    await view.click("Review and queue request");
    view.text("edited");
    await act(async () => state.confirm?.());
    expect(view.onQueue).not.toHaveBeenCalled();
    expect(view.button("Review and queue request").disabled).toBe(false);
    await view.click("Review and queue request");
    const oldConfirm = state.confirm;
    expect(oldConfirm).toBeDefined();
    view.update("other-owner");
    expect(state.controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    await act(async () => oldConfirm?.());
    expect(view.onQueue).not.toHaveBeenCalled();
    expect(view.container.querySelector("textarea")!.value).toBe("");
  });
  it("revokes recording and a pending retry confirmation when the same canonical Codex is disabled", async () => {
    const view = render();
    view.onQueue.mockRejectedValueOnce(new Error("lost ack"));
    await view.click("Voice conversation");
    await view.click("Start voice");
    await view.click("Record turn");
    const controller = state.controllers[0]!;
    view.text("reviewed request");
    await view.click("Review and queue request");
    await act(async () => state.confirm?.());
    expect(view.onQueue).toHaveBeenCalledTimes(1);
    await view.click("Retry confirmed queue request");
    const oldConfirm = state.confirm;
    view.update("owner", false, false);
    expect(controller.dispose).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toBe("");
    await act(async () => oldConfirm?.());
    expect(view.onQueue).toHaveBeenCalledTimes(1);
    expect(controller.record).toHaveBeenCalledTimes(1);
    view.update();
    await view.click("Voice conversation");
    expect(state.controllers[1]!.start).not.toHaveBeenCalled();
    expect(view.button("Start voice").disabled).toBe(false);
    expect(view.container.querySelector("textarea")!.value).toBe("");
  });

  it("disposes on navigation/background and never resumes automatically", async () => {
    const view = render();
    await view.click("Voice conversation");
    state.focused = false;
    view.update();
    expect(state.controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    state.focused = true;
    view.update();
    expect(state.controllers[1]!.start).not.toHaveBeenCalled();
    act(() => state.appState?.("background"));
    expect(state.controllers[1]!.dispose).toHaveBeenCalledTimes(1);
  });
  it("keeps a missing iOS module unavailable, without a fallback", async () => {
    state.available = false;
    const view = render();
    await view.click("Voice conversation");
    expect(view.container.textContent).toContain("Voice unavailable");
    expect(view.button("Start voice").disabled).toBe(true);
    expect(state.controllers).toHaveLength(0);
  });
});
