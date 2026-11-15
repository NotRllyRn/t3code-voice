import "~/index.css";
import { StrictMode, useState, type ComponentProps } from "react";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  DEFAULT_RUNTIME_MODE,
} from "@t3tools/contracts";
import { DEFAULT_INTERACTION_MODE } from "../types";
import { act, render } from "../../test/render";
import { ComposerPrimaryActions } from "../components/chat/ComposerPrimaryActions";
import * as media from "./media.js";
import { VoiceController } from "@t3tools/client-runtime/voice-conversation";
import {
  ComposerLiveVoiceControls,
  ComposerLiveVoiceFeedback,
  useComposerLiveVoice,
} from "./VoicePanel";

vi.mock("../state/session", () => {
  const prepared = {};
  return {
    usePreparedConnection: () => Option.some(prepared),
    useEnvironmentScope: () => true,
  };
});
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../components/SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));
vi.mock("../speech/runEnvironmentSpeech", () => ({
  runEnvironmentSpeech: async () => "wss://voice.example/ws",
}));
vi.mock("./media.js", { spy: true });

function VoiceComposer({
  owner = "thread_1",
  disabled = false,
  provider = "codex",
  model = "custom-model",
  environment = "env_voice",
  scratch = false,
  attachment = false,
  ...actions
}: Partial<ComponentProps<typeof ComposerPrimaryActions>> & {
  owner?: string;
  disabled?: boolean;
  provider?: string;
  model?: string;
  environment?: string;
  scratch?: boolean;
  attachment?: boolean;
}) {
  const [text, setText] = useState("");
  const modelSelection = { instanceId: ProviderInstanceId.make("custom-instance"), model };
  const live = useComposerLiveVoice({
    environmentId: EnvironmentId.make(environment),
    modelSelection,
    threadId: scratch ? undefined : ThreadId.make(owner),
    draft: scratch
      ? {
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
        }
      : undefined,
    disabled: disabled || provider !== "codex",
  });
  const active = live.voice.phase !== "idle" && live.voice.phase !== "error";
  return (
    <form
      className="m-4 max-w-120 rounded-2xl border border-border bg-background p-3 text-foreground"
      onSubmit={(event) => event.preventDefault()}
    >
      <label className="sr-only" htmlFor="draft">
        Message
      </label>
      <input
        id="draft"
        className="mb-4 w-full"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Ask anything…"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-sm text-muted-foreground">
          {provider === "codex" ? "Codex" : "Other provider"}
        </span>
        <ComposerLiveVoiceFeedback live={live} />
        <ComposerPrimaryActions
          compact
          canOperateThread
          pendingAction={null}
          isRunning={false}
          canInterrupt={false}
          isSendBusy={false}
          sendDisabledReason={null}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent={!!text.trim() || attachment}
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          liveVoice={
            provider === "codex" || active
              ? { active, controls: <ComposerLiveVoiceControls live={live} /> }
              : undefined
          }
          {...actions}
        />
      </div>
    </form>
  );
}

it("starts after StrictMode replay and releases late grants on close and owner change", async () => {
  const grants: Array<(stream: MediaStream) => void> = [];
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(() => new Promise((resolve) => grants.push(resolve)));
  const stopped = vi.fn();
  const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
  const panel = (owner: string) => (
    <StrictMode>
      <VoiceComposer owner={owner} />
    </StrictMode>
  );
  await using screen = await render(panel("thread_1"));
  await userEvent.click(screen.getByRole("button", { name: "Start live voice", exact: true }));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Connecting voice…");
  expect(microphone).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Mute live microphone", exact: true }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Stop live voice" }));
  grants[0]!(stream);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Start live voice", exact: true }));
  expect(microphone).toHaveBeenCalledTimes(2);
  await screen.rerender(panel("thread_2"));
  grants[1]!(stream);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(2));
  await expect
    .element(screen.getByRole("button", { name: "Start live voice", exact: true }))
    .toBeVisible();
});

it.each([
  "text",
  "attachment",
  "other provider",
  "busy",
  "run",
  "queue",
  "resume",
  "question",
] as const)("keeps existing primary actions instead of idle live voice for %s", async (mode) => {
  const props = {
    attachment: mode === "attachment" || mode === "queue",
    provider: mode === "other provider" ? "claude" : "codex",
    isSendBusy: mode === "busy",
    isRunning: mode === "run" || mode === "queue",
    canInterrupt: mode === "run" || mode === "queue",
    followUpBehavior: "queue" as const,
    canSteer: true,
    canResume: mode === "resume",
    pendingAction:
      mode === "question"
        ? {
            questionIndex: 0,
            isLastQuestion: true,
            canAdvance: true,
            isResponding: false,
            isComplete: true,
          }
        : null,
  };
  await using screen = await render(<VoiceComposer {...props} />);
  if (mode === "text") await userEvent.type(screen.getByRole("textbox"), "Keep my draft");
  expect(screen.getByRole("button", { name: "Start live voice" }).query()).toBeNull();
  const label =
    mode === "run"
      ? "Stop generation"
      : mode === "busy"
        ? "Submitting message"
        : mode === "resume"
          ? "Resume thread"
          : mode === "question"
            ? "Submit"
            : mode === "queue"
              ? "Queue message"
              : "Submit message";
  await expect.element(screen.getByRole("button", { name: label, exact: true })).toBeVisible();
  if (mode === "text") {
    await userEvent.clear(screen.getByRole("textbox"));
    await expect.element(screen.getByRole("button", { name: "Start live voice" })).toBeVisible();
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it.each(["model", "environment", "disabled", "pagehide", "visibility"] as const)(
  "releases a pending microphone grant on %s change",
  async (change) => {
    const grant = deferred<MediaStream>();
    using _microphone = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockReturnValue(grant.promise);
    const stopped = vi.fn();
    const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
    await using screen = await render(<VoiceComposer />);
    await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    if (change === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else if (change === "visibility") {
      using _hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    } else
      await screen.rerender(
        <VoiceComposer
          model={change === "model" ? "other-model" : "custom-model"}
          environment={change === "environment" ? "env_other" : "env_voice"}
          disabled={change === "disabled"}
        />,
      );
    grant.resolve(stream);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
    await expect.element(screen.getByRole("button", { name: "Start live voice" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop live voice" }).query()).toBeNull();
  },
);

class VoiceSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  connected = deferred<void>();
  send = vi.fn();
  close = vi.fn();
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    super.addEventListener(...args);
    if (args[0] === "message") this.connected.resolve();
  }
  event(data: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

it.each([false, true])(
  "keeps mute/stop with drafts and attachments, errors visible, provider cleanup (Scratch: %s)",
  async (scratch) => {
    const socket = new VoiceSocket();
    using _socketFactory = vi.spyOn(window, "WebSocket").mockImplementation(function () {
      return socket as unknown as WebSocket;
    });
    const dispose = vi.fn();
    const mute = vi.fn();
    using _audio = vi.spyOn(media, "browserMedia").mockResolvedValue({
      dispose,
      mute,
      capture: vi.fn(),
      finishCapture: async () => {},
      allow: vi.fn(),
      silence: async () => null,
      enqueue: vi.fn(),
      drain: async () => {},
    });
    using start = vi.spyOn(VoiceController.prototype, "start");
    await using screen = await render(<VoiceComposer scratch={scratch} liveVoice={undefined} />);
    const capture = (state: string) =>
      page.screenshot({
        element: screen.container,
        path: `../../../../.t3/t3voice-clean-after-${scratch ? "draft" : "thread"}-${state}.png`,
      });
    await capture("normal-empty");
    await userEvent.type(screen.getByRole("textbox"), "Keep this draft");
    await capture("normal-typed");
    await screen.rerender(<VoiceComposer scratch={scratch} />);
    await capture("typed");
    await userEvent.clear(screen.getByRole("textbox"));
    await capture("empty");
    await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    await socket.connected.promise;
    const url = new URL(String(_socketFactory.mock.calls[0]![0]));
    expect(url.searchParams.get("continuous")).toBe("1");
    if (scratch) {
      expect(JSON.parse(url.searchParams.get("draft")!).modelSelection).toEqual({
        instanceId: "custom-instance",
        model: "custom-model",
      });
      expect(url.searchParams.has("threadId")).toBe(false);
    } else {
      expect(url.searchParams.get("threadId")).toBe("thread_1");
    }
    await act(() => socket.event({ type: "relay.ready" }));
    await expect
      .element(screen.getByRole("button", { name: "Mute live microphone" }))
      .toBeEnabled();
    const controller = start.mock.contexts[0] as VoiceController;
    await act(() => {
      socket.event({ type: "input_audio_buffer.committed", item_id: "input_1" });
      socket.event({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "input_1",
        delta: "My voice request",
      });
      socket.event({ type: "relay.response", voice_turn: "turn_1" });
      socket.event({
        type: "response.created",
        response: { id: "reply_1", metadata: { voice_turn: "turn_1" } },
      });
      socket.event({
        type: "response.output_audio_transcript.delta",
        response_id: "reply_1",
        item_id: "output_1",
        content_index: 0,
        delta: "My voice reply",
      });
    });
    await vi.waitFor(() => {
      expect(controller.state.transcriptStatus).toBe("live");
      expect(controller.state.replyPartial).toBe(true);
    });
    expect(screen.container.textContent).not.toContain("My voice request");
    expect(screen.container.textContent).not.toContain("My voice reply");
    await act(() => {
      socket.event({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "input_1",
        transcript: "My voice request",
      });
      socket.event({ type: "agent.recorded", item_id: "input_1" });
      socket.event({
        type: "response.output_audio_transcript.done",
        response_id: "reply_1",
        item_id: "output_1",
        content_index: 0,
        transcript: "My voice reply",
      });
    });
    await vi.waitFor(() => {
      expect(controller.state.transcriptStatus).toBe("saved");
      expect(controller.state.replyPartial).toBe(false);
    });
    expect(controller.state.transcript).toBe("My voice request");
    expect(controller.state.reply).toBe("My voice reply");
    expect(screen.container.textContent).not.toContain("My voice request");
    expect(screen.container.textContent).not.toContain("My voice reply");
    await expect.element(screen.getByRole("status")).toHaveClass("sr-only");
    await capture("active");
    await userEvent.click(screen.getByRole("button", { name: "Mute live microphone" }));
    await expect
      .element(screen.getByRole("button", { name: "Unmute live microphone" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(mute).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.tab();
    await expect
      .element(screen.getByRole("button", { name: "Unmute live microphone" }))
      .toHaveFocus();
    await userEvent.tab();
    await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Stop live voice" }).element().getBoundingClientRect()
        .right,
    ).toBeLessThanOrEqual(window.innerWidth);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Mic muted");
    await capture("muted");
    await userEvent.type(screen.getByRole("textbox"), "Keep this draft");
    await expect
      .element(screen.getByRole("button", { name: "Submit message", exact: true }))
      .toBeEnabled();
    await expect
      .element(screen.getByRole("button", { name: "Unmute live microphone" }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeVisible();
    expect(dispose).not.toHaveBeenCalled();
    await capture("active-typed");
    if (scratch) {
      await act(() => socket.event({ type: "agent.bound", thread_id: "created_thread" }));
      await expect
        .element(screen.getByRole("link", { name: "Open chat (stops voice)" }))
        .toHaveAttribute("href", "/env_voice/created_thread");
      await userEvent.click(screen.getByRole("textbox"));
      await userEvent.tab();
      await expect
        .element(screen.getByRole("link", { name: "Open chat (stops voice)" }))
        .toHaveFocus();
      await capture("open-chat");
    }
    await screen.rerender(<VoiceComposer scratch={scratch} attachment />);
    await userEvent.clear(screen.getByRole("textbox"));
    await expect
      .element(screen.getByRole("button", { name: "Submit message", exact: true }))
      .toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeVisible();
    expect(dispose).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox"), "Keep this draft");
    await act(() => socket.dispatchEvent(new Event("error")));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Voice disconnected. Check server configuration or start again.");
    await expect.element(screen.getByRole("button", { name: "Live voice error" })).toBeVisible();
    await capture("error");
    await userEvent.click(screen.getByRole("button", { name: "Live voice error" }));
    await expect
      .element(
        page
          .getByRole("dialog")
          .getByText("Voice disconnected. Check server configuration or start again."),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try voice again" })).toBeEnabled();
    await page.screenshot({
      path: `../../../../.t3/t3voice-clean-after-${scratch ? "draft" : "thread"}-error-popover.png`,
    });
    await expect.element(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    expect(dispose).toHaveBeenCalled();
    await userEvent.clear(screen.getByRole("textbox"));
    await screen.rerender(<VoiceComposer scratch={scratch} />);
    socket.connected = deferred<void>();
    await userEvent.click(page.getByRole("button", { name: "Try voice again" }));
    await socket.connected.promise;
    await act(() => socket.event({ type: "relay.ready" }));
    expect(screen.getByRole("button", { name: "Live voice error" }).query()).toBeNull();
    await expect
      .element(screen.getByRole("button", { name: "Mute live microphone" }))
      .toBeEnabled();
    await screen.rerender(<VoiceComposer scratch={scratch} provider="claude" />);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Stop live voice" }).query()).toBeNull();
  },
);
