import "~/index.css";
import { StrictMode, useState, type ComponentProps } from "react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useLocation } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  ProjectId,
  DEFAULT_RUNTIME_MODE,
  type LiveVoiceServerEvent,
  type ServerConfig,
} from "@t3tools/contracts";
import * as voiceInput from "@t3tools/client-runtime/voice-input";
import { DEFAULT_INTERACTION_MODE } from "../types";
import { serverEnvironment } from "../state/server";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { act, render } from "../../test/render";
import { ThreadRouteView } from "../components/ThreadRouteView";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { ComposerPrimaryActions } from "../components/chat/ComposerPrimaryActions";
import * as media from "./liveMedia";
import type { LiveMedia, LiveMediaOptions } from "@t3tools/client-runtime/voice-conversation";
import {
  ComposerLiveVoiceControls,
  ComposerLiveVoiceFeedback,
  useComposerLiveVoice,
} from "./VoicePanel";

const routeState = vi.hoisted(() => ({ shellReady: false }));
vi.mock("../components/ChatView", () => ({
  default: (props: { routeKind: string; threadId: string; environmentId: string }) => (
    <VoiceComposer
      scratch={props.routeKind === "draft"}
      owner={props.threadId}
      environment={props.environmentId}
    />
  ),
}));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../state/entities", () => ({
  useEnvironmentThreadRefs: () => [],
  useAnyEnvironmentHiding: () => false,
  useQuietThreadShell: (ref: unknown) =>
    routeState.shellReady && ref ? { deletedAt: null } : null,
}));
vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => "live" }));
vi.mock("../state/threads", () => ({
  environmentThreadShells: { hiddenThreadKeysAtom: Atom.make(new Set()) },
  threadFamilies: { mount: () => () => {} },
  useEnvironmentThread: () => ({ status: "loading", data: Option.none() }),
}));
vi.mock("../state/session", () => {
  const prepared = new Map<string, { environmentId: string }>();
  const readPreparedConnection = (environmentId: string) => {
    if (!prepared.has(environmentId)) prepared.set(environmentId, { environmentId });
    return prepared.get(environmentId)!;
  };
  return {
    readPreparedConnection,
    usePreparedConnection: (environmentId: string) =>
      Option.some(readPreparedConnection(environmentId)),
    useEnvironmentScope: () => true,
  };
});
vi.mock("../state/server", () => ({
  serverEnvironment: {
    configValueAtom: Atom.family((environmentId: string) =>
      Atom.make({ environment: { environmentId, capabilities: { nativeLiveVoice: true } } }),
    ),
  },
}));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../components/SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));
vi.mock("../speech/runEnvironmentSpeech", () => ({
  runEnvironmentSpeech: vi.fn(async () => "wss://voice.example/api/voice/live"),
}));
vi.mock("./liveMedia", { spy: true });
vi.mock("@t3tools/client-runtime/voice-input", { spy: true });

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
    draftId: scratch ? "draft_voice" : undefined,
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class VoiceSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  event(event: LiveVoiceServerEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}
function setup(acquire?: (value: LiveMedia) => Promise<LiveMedia>) {
  routeState.shellReady = false;
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {},
    draftsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    promotedDraftRedirects: {},
  });
  const sockets: VoiceSocket[] = [];
  const socketFactory = vi.spyOn(window, "WebSocket").mockImplementation(function () {
    const socket = new VoiceSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const attempts: Array<{ value: LiveMedia; options: LiveMediaOptions }> = [];
  const audio = vi.spyOn(media, "browserLiveMedia").mockImplementation(async (options) => {
    const value: LiveMedia = {
      offer: async () => "v=0\r\ns=fictional\r\n",
      answer: vi.fn(async () => {}),
      microphone: vi.fn(),
      playback: vi.fn(async () => {}),
      stopAudio: vi.fn(),
      dispose: vi.fn(),
    };
    attempts.push({ value, options });
    return acquire ? acquire(value) : value;
  });
  return {
    sockets,
    attempts,
    socketFactory,
    audio,
    async authorize(attemptId = "attempt_1") {
      await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
      await act(() =>
        sockets
          .at(-1)!
          .event({ type: "live.status", sessionId: "session_1", phase: "connecting", attemptId }),
      );
      await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0));
    },
    async connect() {
      await this.authorize();
      await act(() => {
        sockets.at(-1)!.event({
          type: "live.answer",
          sessionId: "session_1",
          attemptId: "attempt_1",
          answerSdp: "v=0\r\ns=fictional\r\n",
        });
        attempts.at(-1)!.options.peer("connected");
        sockets.at(-1)!.event({
          type: "live.status",
          sessionId: "session_1",
          phase: "connected",
          attemptId: "attempt_1",
        });
      });
      await vi.waitFor(() =>
        expect(attempts.at(-1)!.value.microphone).toHaveBeenLastCalledWith(true),
      );
    },
    [Symbol.dispose]() {
      sockets.forEach((socket) =>
        socket.event({ type: "live.cleanup", sessionId: "session_1", result: "acknowledged" }),
      );
      audio.mockRestore();
      socketFactory.mockRestore();
    },
  };
}

it.each(["loading", "legacy", "unsupported", "wrong environment"] as const)(
  "blocks %s capability without requesting a live ticket, then accepts the selected server",
  async (mode) => {
    using h = setup();
    const environmentId = EnvironmentId.make("env_remote");
    const config = (capabilities: object, id = environmentId) =>
      ({ environment: { environmentId: id, capabilities } }) as unknown as ServerConfig;
    const initial =
      mode === "loading"
        ? null
        : config(
            mode === "legacy" ? {} : { nativeLiveVoice: mode === "wrong environment" },
            mode === "wrong environment" ? EnvironmentId.make("env_local") : environmentId,
          );
    const configAtom = Atom.make<ServerConfig | null>(initial);
    using _config = vi.spyOn(serverEnvironment, "configValueAtom").mockReturnValue(configAtom);
    vi.mocked(runEnvironmentSpeech).mockClear();
    vi.mocked(voiceInput.getEnvironmentLiveVoiceUrl).mockClear();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <VoiceComposer environment={environmentId} />
      </AppAtomRegistryProvider>,
    );
    const start = screen.getByRole("button", { name: "Start live voice" });
    await expect.element(start).toBeDisabled();
    expect(runEnvironmentSpeech).not.toHaveBeenCalled();
    expect(voiceInput.getEnvironmentLiveVoiceUrl).not.toHaveBeenCalled();
    expect(h.sockets).toHaveLength(0);
    await userEvent.hover(start.element().parentElement!);
    await expect
      .element(
        page.getByText(
          mode === "loading"
            ? "Waiting for this environment's live voice capabilities"
            : mode === "wrong environment"
              ? "The environment connection changed. Reconnect and try live voice again."
              : "This server does not support native live voice. Update T3 Code on this environment and reconnect.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await act(() => appAtomRegistry.set(configAtom, config({ nativeLiveVoice: true })));
    await userEvent.click(start);
    await h.authorize();
    expect(runEnvironmentSpeech).toHaveBeenCalledOnce();
    expect(voiceInput.getEnvironmentLiveVoiceUrl).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId }),
      config({ nativeLiveVoice: true }).environment,
    );
    expect(h.socketFactory.mock.calls.at(-1)?.[0]).toContain("threadId=thread_1");
  },
);

it.each([
  "text",
  "attachment",
  "other provider",
  "busy",
  "run",
  "queue",
  "resume",
  "question",
] as const)("preserves original primary actions for %s", async (mode) => {
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

it.each(["stop", "thread", "model", "environment", "disabled", "pagehide", "visibility"] as const)(
  "StrictMode disposes late media on %s without a second owner",
  async (change) => {
    const grant = deferred<LiveMedia>();
    using h = setup(async () => grant.promise);
    const panel = (props = {}) => (
      <StrictMode>
        <VoiceComposer {...props} />
      </StrictMode>
    );
    await using screen = await render(panel());
    await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    expect(h.audio).not.toHaveBeenCalled();
    await h.authorize();
    if (change === "stop")
      await userEvent.click(screen.getByRole("button", { name: "Stop live voice" }));
    else if (change === "pagehide") await act(() => window.dispatchEvent(new Event("pagehide")));
    else if (change === "visibility") {
      using _hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      await act(() => document.dispatchEvent(new Event("visibilitychange")));
    } else
      await screen.rerender(
        panel({
          owner: change === "thread" ? "thread_2" : "thread_1",
          model: change === "model" ? "other" : "custom-model",
          environment: change === "environment" ? "env_other" : "env_voice",
          disabled: change === "disabled",
        }),
      );
    grant.resolve(h.attempts[0]!.value);
    await vi.waitFor(() => expect(h.attempts[0]!.value.dispose).toHaveBeenCalledTimes(1));
    expect(h.attempts[0]!.options.signal.aborted).toBe(true);
    expect(h.audio).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("button", { name: "Start live voice" })).toBeVisible();
  },
);

function RoutedVoiceComposer() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [first, second] = pathname.slice(1).split("/");
  const target = resolveThreadRouteTarget(
    first === "draft" ? { draftId: second } : { environmentId: first, threadId: second },
  );
  return target ? <ThreadRouteView target={target} /> : null;
}

it.each(["link", "sidebar", "redirect"] as const)(
  "preserves the actual keyed route owner on draft promotion via %s",
  async (navigation) => {
    using h = setup();
    const draftId = DraftId.make("draft_voice");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(
      {
        environmentId: EnvironmentId.make("env_voice"),
        projectId: ProjectId.make("project_voice"),
      },
      draftId,
      { threadId: ThreadId.make("local_draft_thread") },
    );
    store.setPrompt(draftId, "Keep unsent text");
    await using screen = await render(<RoutedVoiceComposer />, { router: "/draft/draft_voice" });
    const navigateThread = (threadId: string) =>
      act(() =>
        screen.router!.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: "env_voice", threadId },
        }),
      );
    await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    await h.connect();
    const url = new URL(String(h.socketFactory.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/voice/live");
    expect(url.searchParams.has("continuous")).toBe(false);
    expect(JSON.parse(url.searchParams.get("draft")!).modelSelection.model).toBe("custom-model");
    await act(() =>
      h.sockets[0]!.event({ type: "live.bound", threadId: ThreadId.make("created_thread") }),
    );
    await expect
      .element(screen.getByRole("link", { name: "Open chat (keeps voice)" }))
      .toHaveAttribute("href", "/env_voice/created_thread");
    if (navigation === "link")
      await userEvent.click(screen.getByRole("link", { name: "Open chat (keeps voice)" }));
    else if (navigation === "sidebar") await navigateThread("created_thread");
    else {
      routeState.shellReady = true;
      await act(() => store.finalizePromotedDraftThread(draftId));
    }
    await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeVisible();
    expect(h.attempts[0]!.value.dispose).not.toHaveBeenCalled();
    expect(h.audio).toHaveBeenCalledTimes(1);
    expect(h.sockets[0]!.close).not.toHaveBeenCalled();
    if (navigation === "link")
      await page.screenshot({
        element: screen.container,
        path: "../../../../.t3/t3voice-live-client-fix-promotion-r1.png",
      });
    const ref = {
      environmentId: EnvironmentId.make("env_voice"),
      threadId: ThreadId.make("created_thread"),
    };
    expect(store.getDraftIdByRef(ref)).toBe(navigation === "redirect" ? null : draftId);
    expect(store.getComposerDraft(ref)?.prompt).toBe("Keep unsent text");
    routeState.shellReady = true;
    await act(() => store.finalizePromotedDraftThread(draftId));
    expect(h.attempts[0]!.value.dispose).not.toHaveBeenCalled();
    expect(store.getComposerDraft(ref)?.prompt).toBe("Keep unsent text");
    await navigateThread("unrelated_thread");
    expect(h.attempts[0]!.value.stopAudio).toHaveBeenCalledTimes(1);
    expect(h.attempts[0]!.value.dispose).not.toHaveBeenCalled();
    await act(() =>
      h.sockets[0]!.event({ type: "live.cleanup", sessionId: "session_1", result: "acknowledged" }),
    );
    expect(h.attempts[0]!.value.dispose).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("button", { name: "Start live voice" })).toBeVisible();
    await navigateThread("created_thread");
    await expect.element(screen.getByRole("button", { name: "Start live voice" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
    expect(new URL(String(h.socketFactory.mock.calls[1]![0])).searchParams.get("threadId")).toBe(
      "created_thread",
    );
    await h.connect();
    await screen.unmount();
    expect(h.attempts[1]!.value.stopAudio).toHaveBeenCalledTimes(1);
    await act(() =>
      h.sockets[1]!.event({ type: "live.cleanup", sessionId: "session_1", result: "acknowledged" }),
    );
    expect(h.attempts[1]!.value.dispose).toHaveBeenCalledTimes(1);
    expect(h.sockets[1]!.close).toHaveBeenCalledTimes(1);
  },
);

it.each(["ready", "muted", "blocked"] as const)(
  "announces local readiness only after answer, peer and playback are %s",
  async (outcome) => {
    const answer = deferred<void>();
    const playback = deferred<void>();
    using h = setup(async (value) => {
      value.answer = vi.fn(() => answer.promise);
      value.playback = vi.fn(() => playback.promise);
      return value;
    });
    await using screen = await render(<VoiceComposer />);
    await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    await h.authorize();
    await act(() => {
      h.sockets[0]!.event({
        type: "live.answer",
        sessionId: "session_1",
        attemptId: "attempt_1",
        answerSdp: "v=0\r\ns=fictional\r\n",
      });
      h.sockets[0]!.event({
        type: "live.status",
        sessionId: "session_1",
        attemptId: "attempt_1",
        phase: "connected",
      });
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent("Connecting voice…");
    expect(h.attempts[0]!.value.microphone).toHaveBeenLastCalledWith(false);
    await act(() => answer.resolve());
    expect(h.attempts[0]!.value.playback).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Connecting voice…");
    await act(() => h.attempts[0]!.options.peer("connected"));
    expect(h.attempts[0]!.value.playback).toHaveBeenCalledTimes(1);
    expect(h.attempts[0]!.value.microphone).toHaveBeenLastCalledWith(false);
    await expect.element(screen.getByRole("status")).toHaveTextContent("Connecting voice…");
    if (outcome !== "blocked") {
      await expect
        .element(screen.getByRole("button", { name: "Connecting live voice" }))
        .toBeDisabled();
      await act(() => playback.resolve());
      await expect.element(screen.getByRole("status")).toHaveTextContent("Listening");
      if (outcome === "muted")
        await userEvent.click(screen.getByRole("button", { name: "Mute live microphone" }));
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent(outcome === "muted" ? "Mic muted" : "Listening");
      expect(h.attempts[0]!.value.microphone).toHaveBeenLastCalledWith(outcome !== "muted");
    } else {
      await act(() => playback.reject(Error("private-autoplay-error")));
      await expect
        .element(screen.getByRole("status"))
        .toHaveTextContent("Stopping voice. Microphone and playback are off.");
      expect(h.attempts[0]!.value.stopAudio).toHaveBeenCalledTimes(1);
      await act(() =>
        h.sockets[0]!.event({
          type: "live.cleanup",
          sessionId: "session_1",
          result: "acknowledged",
        }),
      );
      await expect
        .element(screen.getByRole("alert"))
        .toHaveTextContent(
          "Voice playback was blocked. Allow audio playback and start voice again.",
        );
      await expect.element(screen.getByRole("status")).toHaveTextContent("");
      expect(h.attempts[0]!.value.microphone).toHaveBeenLastCalledWith(false);
      expect(h.attempts[0]!.value.dispose).toHaveBeenCalledTimes(1);
    }
  },
);

it("keeps Send, mic mute, original coding Stop; accessible refresh and playback error, retry without transcript in composer", async () => {
  using h = setup();
  await using screen = await render(<VoiceComposer />);
  const capture = (state: string) =>
    page.screenshot({
      element: screen.container,
      path: `../../../../.t3/t3voice-live-client-${state}.png`,
    });
  await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
  await expect
    .element(screen.getByRole("button", { name: "Connecting live voice" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Connecting live voice" }))
    .toHaveAttribute("aria-busy", "true");
  await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeEnabled();
  await userEvent.hover(screen.getByRole("button", { name: "Connecting live voice" }));
  await expect
    .element(
      page.getByText("Connecting live voice. Microphone is off; Stop is available.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.hover(screen.getByRole("textbox"));
  await expect
    .element(
      page.getByText("Connecting live voice. Microphone is off; Stop is available.", {
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  await capture("connecting");
  await h.connect();
  await act(() => {
    h.sockets[0]!.event({
      type: "live.caption",
      sessionId: "session_1",
      segmentId: "input_1",
      revision: 1,
      role: "user",
      text: "Private live preview",
      committed: false,
    });
    h.sockets[0]!.event({
      type: "live.caption",
      sessionId: "session_1",
      segmentId: "output_1",
      revision: 1,
      role: "assistant",
      text: "Concurrent output preview",
      committed: false,
    });
  });
  expect(screen.container.textContent).not.toContain("Private live preview");
  expect(screen.container.textContent).not.toContain("Concurrent output preview");
  await capture("active");
  await userEvent.click(screen.getByRole("button", { name: "Mute live microphone" }));
  await expect
    .element(screen.getByRole("button", { name: "Unmute live microphone" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(h.attempts[0]!.value.microphone).toHaveBeenLastCalledWith(false);
  await userEvent.type(screen.getByRole("textbox"), "Keep my draft");
  await expect
    .element(screen.getByRole("button", { name: "Submit message", exact: true }))
    .toBeEnabled();
  await screen.rerender(<VoiceComposer isRunning canInterrupt attachment />);
  await expect
    .element(screen.getByRole("button", { name: "Steer message", exact: true }))
    .toBeEnabled();
  await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeVisible();
  expect(h.attempts[0]!.value.dispose).not.toHaveBeenCalled();
  await capture("muted-typed-running");
  await screen.rerender(<VoiceComposer isRunning canInterrupt />);
  await userEvent.clear(screen.getByRole("textbox"));
  await expect.element(screen.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Stop live voice" }));
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Stopping voice. Microphone and playback are off.");
  expect(h.attempts[0]!.value.stopAudio).toHaveBeenCalledTimes(1);
  expect(h.attempts[0]!.value.dispose).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "Stopping live voice" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start live voice" }).query()).toBeNull();
  await capture("stopping");
  await act(() =>
    h.sockets[0]!.event({ type: "live.cleanup", sessionId: "session_1", result: "acknowledged" }),
  );
  await screen.rerender(<VoiceComposer />);
  await userEvent.click(screen.getByRole("button", { name: "Start live voice" }));
  await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
  await userEvent.type(screen.getByRole("textbox"), "Keep my draft");
  await act(() =>
    h.sockets[1]!.event({
      type: "live.status",
      sessionId: "session_1",
      phase: "refresh_wait",
      retryAt: 1_800_000_090_000,
      reason: "refresh-pending",
    }),
  );
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "Waiting for the selected provider to refresh. You can stop voice at any time.",
    );
  await expect.element(screen.getByRole("button", { name: "Stop live voice" })).toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: "Waiting for provider refresh" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Waiting for provider refresh" }))
    .toHaveAttribute("aria-busy", "true");
  await capture("refresh");
  await act(() =>
    h.sockets[1]!.event({
      type: "live.status",
      sessionId: "session_1",
      phase: "error",
      reason: "playback-blocked",
    }),
  );
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Voice playback was blocked. Allow audio playback and start voice again.");
  await expect.element(screen.getByRole("textbox")).toHaveValue("Keep my draft");
  await userEvent.click(screen.getByRole("button", { name: "Live voice error" }));
  await expect.element(page.getByRole("button", { name: "Try voice again" })).toBeEnabled();
  await capture("playback-error");
  await userEvent.click(page.getByRole("button", { name: "Try voice again" }));
  await vi.waitFor(() => expect(h.sockets).toHaveLength(3));
  await userEvent.click(screen.getByRole("button", { name: "Stop live voice" }));
  expect(h.audio).toHaveBeenCalledTimes(1);
});
