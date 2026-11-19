import { useAtomValue } from "@effect/atom-react";
import {
  getEnvironmentLiveVoiceUrl,
  supportsEnvironmentNativeLiveVoice,
} from "@t3tools/client-runtime/voice-input";
import {
  LiveVoiceController,
  INITIAL_LIVE_VOICE_STATE,
  type LiveVoiceState,
} from "@t3tools/client-runtime/voice-conversation";
import {
  AuthOrchestrationOperateScope,
  LiveVoiceStartupError,
  type EnvironmentId,
  type ThreadId,
  type ModelSelection,
  type LiveVoiceDraft,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "../state/session";
import { serverEnvironment } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import {
  MicIcon,
  LoaderCircleIcon,
  MicOffIcon,
  XIcon,
  AudioLinesIcon,
  CircleAlertIcon,
  MessageSquareIcon,
} from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { browserLiveMedia } from "./liveMedia";
import { liveCaptionKey, liveCaptions } from "./liveCaptions";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";

interface Props {
  environmentId: EnvironmentId;
  threadId?: ThreadId | undefined;
  draftId?: string | undefined;
  modelSelection?: ModelSelection | undefined;
  draft?: LiveVoiceDraft | undefined;
  disabled: boolean;
}
function supported() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const mobile =
    /Android|iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return (
    !mobile &&
    window.isSecureContext &&
    typeof RTCPeerConnection !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function useComposerLiveVoice({
  environmentId,
  threadId,
  draftId,
  modelSelection,
  draft,
  disabled,
}: Props) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const descriptor = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment;
  const nativeLiveSupported =
    descriptor?.environmentId === environmentId && supportsEnvironmentNativeLiveVoice(descriptor);
  const binding = JSON.stringify({ environmentId, threadId, draftId, modelSelection, draft });
  const selection = JSON.stringify(modelSelection ?? draft?.modelSelection);
  const [snapshot, setSnapshot] = useState<{
    controller: LiveVoiceController | null;
    value: LiveVoiceState;
  }>({ controller: null, value: INITIAL_LIVE_VOICE_STATE });
  const owner = useRef<{
    prepared: typeof prepared;
    binding: string;
    selection: string;
    environmentId: EnvironmentId;
    promotedThread?: ThreadId;
    controller: LiveVoiceController;
    token: symbol;
    target: { threadId?: ThreadId | undefined; draft?: LiveVoiceDraft | undefined };
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Unmount and StrictMode replay release the external control socket and microphone owner.
  useEffect(
    () => () => {
      if (owner.current) {
        liveCaptions.clear(owner.current.token);
        owner.current.controller.dispose();
        owner.current = null;
      }
    },
    [],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronize environment/binding with the external owner; authoritative draft promotion is not a new session.
  useEffect(() => {
    const previous = owner.current;
    const promotion =
      previous &&
      threadId &&
      previous.promotedThread === threadId &&
      previous.environmentId === environmentId &&
      previous.selection === selection;
    if (previous && previous.prepared === prepared && (previous.binding === binding || promotion)) {
      previous.binding = binding;
      previous.target = { threadId, draft };
      return;
    }
    if (previous) {
      liveCaptions.clear(previous.token);
      previous.controller.dispose();
      owner.current = null;
    }
    if (!prepared) {
      // oxlint-disable-next-line react/set-state-in-effect -- Publish loss of the external connection owner to its controls.
      setSnapshot({ controller: null, value: INITIAL_LIVE_VOICE_STATE });
      return;
    }
    const token = Symbol("Live owner");
    let showingCaptions = false;
    const target = { threadId, draft };
    const controller = new LiveVoiceController(
      {
        media: browserLiveMedia,
        socket: (url) => new WebSocket(url),
        url: async (signal) => {
          if (readPreparedConnection(environmentId) !== prepared) {
            throw new LiveVoiceStartupError({ reason: "connection-changed" });
          }
          const currentDescriptor = appAtomRegistry.get(
            serverEnvironment.configValueAtom(environmentId),
          )?.environment;
          const url = new URL(
            await runEnvironmentSpeech(getEnvironmentLiveVoiceUrl(prepared, currentDescriptor), {
              signal,
            }),
          );
          const current = owner.current?.controller === controller ? owner.current.target : target;
          if (current.threadId) url.searchParams.set("threadId", current.threadId);
          else url.searchParams.set("draft", JSON.stringify(current.draft));
          return url.toString();
        },
        event: (event) => {
          if (event.type === "live.caption") liveCaptions.caption(token, event);
          if (event.type === "live.bound" && owner.current?.controller === controller) {
            owner.current.promotedThread = event.threadId;
            owner.current.target = { threadId: event.threadId };
            liveCaptions.bind(token, liveCaptionKey(environmentId, event.threadId));
            if (!threadId && draftId) {
              const store = useComposerDraftStore.getState();
              const id = DraftId.make(draftId);
              if (store.getDraftSession(id)?.environmentId === environmentId)
                store.markDraftThreadPromoting(id, { environmentId, threadId: event.threadId });
            }
          }
        },
      },
      (value) => {
        if (value.phase === "connecting" && !showingCaptions) {
          showingCaptions = true;
          const current = owner.current?.target ?? target;
          liveCaptions.begin(token, liveCaptionKey(environmentId, current.threadId, draftId));
        }
        if (value.phase === "idle" || value.phase === "error") {
          showingCaptions = false;
          liveCaptions.finish(token);
        }
        setSnapshot({ controller, value });
      },
    );
    owner.current = { prepared, binding, selection, environmentId, controller, token, target };
    setSnapshot({ controller, value: INITIAL_LIVE_VOICE_STATE });
  }, [prepared, binding, selection, environmentId, threadId, draftId, draft]);
  const controller = snapshot.controller;
  const voice = snapshot.value;
  const allowed =
    !disabled && canOperate && !!prepared && !!controller && supported() && nativeLiveSupported;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Permission/connection loss must release external media resources.
  useEffect(() => {
    if (!allowed) controller?.stop();
  }, [allowed, controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Browser lifecycle events release microphone and playback.
  useEffect(() => {
    const stop = () => controller?.stop();
    const visibility = () => {
      if (document.hidden) stop();
    };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [controller]);
  const unavailableReason = !supported()
    ? "Live voice requires a secure desktop browser with WebRTC and microphone support"
    : !canOperate
      ? "Live voice requires permission to operate this environment"
      : !prepared
        ? "Connect to use live voice"
        : !descriptor
          ? "Waiting for this environment's live voice capabilities"
          : descriptor.environmentId !== environmentId
            ? "The environment connection changed. Reconnect and try live voice again."
            : !nativeLiveSupported
              ? "This server does not support native live voice. Update T3 Code on this environment and reconnect."
              : disabled
                ? "Live voice is unavailable for the current composer"
                : null;
  return { controller, voice, allowed, unavailableReason, environmentId, threadId };
}

type LiveVoice = ReturnType<typeof useComposerLiveVoice>;

const voiceButtonClassName =
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 sm:size-8 [&_svg]:size-4";

export function ComposerLiveVoiceControls({ live }: { live: LiveVoice }) {
  const { voice, controller, allowed, unavailableReason } = live;
  const active = voice.phase !== "idle" && voice.phase !== "error";
  const button = (
    label: string,
    action: () => void,
    icon: ReactNode,
    props: {
      disabled?: boolean;
      pressed?: boolean | undefined;
      muted?: boolean;
      busy?: boolean;
      tooltip?: string | null;
    } = {},
  ) => (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={props.pressed}
          aria-busy={props.busy || undefined}
          disabled={props.disabled}
          onClick={action}
          className={cn(
            voiceButtonClassName,
            props.muted
              ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
              : "bg-message-action text-message-action-foreground hover:bg-message-action-hover",
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipPopup>{props.tooltip ?? label}</TooltipPopup>
    </Tooltip>
  );
  if (!active)
    return button(
      "Start live voice",
      () => void controller?.start(),
      <AudioLinesIcon aria-hidden="true" />,
      { disabled: !allowed, tooltip: unavailableReason },
    );
  const waiting =
    voice.phase === "connecting" ||
    voice.phase === "refresh_wait" ||
    voice.phase === "reconnecting";
  const microphoneLabel =
    voice.phase === "reconnecting"
      ? `Reconnecting live voice (${voice.recoveryAttempt}/4)`
      : voice.phase === "connecting"
        ? "Connecting live voice"
        : voice.phase === "refresh_wait"
          ? "Waiting for provider refresh"
          : voice.phase === "stopping"
            ? "Live microphone off"
            : voice.muted
              ? "Unmute live microphone"
              : "Mute live microphone";
  const busyIcon = (
    <LoaderCircleIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
  );
  return (
    <>
      {button(
        microphoneLabel,
        () => void controller?.mute(),
        waiting ? (
          busyIcon
        ) : voice.muted ? (
          <MicOffIcon aria-hidden="true" />
        ) : (
          <MicIcon aria-hidden="true" />
        ),
        {
          disabled: voice.phase !== "connected",
          busy: waiting,
          pressed: voice.phase === "connected" ? voice.muted : undefined,
          muted: voice.phase === "connected" && voice.muted,
          tooltip: waiting
            ? `${microphoneLabel}. Microphone is off; Stop is available.`
            : microphoneLabel,
        },
      )}
      {button(
        voice.phase === "stopping" ? "Stopping live voice" : "Stop live voice",
        () => void controller?.stop(),
        voice.phase === "stopping" ? busyIcon : <XIcon aria-hidden="true" />,
        {
          disabled: voice.phase === "stopping",
          busy: voice.phase === "stopping",
          tooltip:
            voice.phase === "stopping"
              ? "Finishing voice cleanup. Microphone and playback are off."
              : "Stop live voice",
        },
      )}
    </>
  );
}

export function ComposerLiveVoiceFeedback({ live }: { live: LiveVoice }) {
  const { voice, environmentId, threadId, controller, allowed } = live;
  const active = voice.phase !== "idle" && voice.phase !== "error";
  return (
    <>
      <span role="status" className="sr-only">
        {active
          ? voice.phase === "stopping"
            ? "Stopping voice. Microphone and playback are off."
            : voice.phase === "reconnecting"
              ? `Reconnecting voice, attempt ${voice.recoveryAttempt} of 4. Microphone is off; Stop is available.`
              : voice.phase === "refresh_wait"
                ? "Waiting for the selected provider to refresh. You can stop voice at any time."
                : voice.phase !== "connected"
                  ? "Connecting voice…"
                  : voice.muted
                    ? "Mic muted"
                    : "Listening"
          : ""}
      </span>
      <span role="alert" className="sr-only">
        {voice.error}
      </span>
      {voice.error ? (
        <Popover key={voice.error}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Live voice error"
                className={cn(voiceButtonClassName, "text-destructive hover:bg-destructive/15")}
              />
            }
          >
            <CircleAlertIcon aria-hidden="true" />
          </PopoverTrigger>
          <PopoverPopup side="top" align="end" width="sm" padding="compact">
            <PopoverTitle>Voice stopped</PopoverTitle>
            <p className="my-2 max-h-40 overflow-y-auto break-words text-sm">{voice.error}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!allowed || active}
              onClick={() => void controller?.start()}
            >
              Try voice again
            </Button>
          </PopoverPopup>
        </Popover>
      ) : null}
      {voice.threadId && !threadId ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: voice.threadId }}
                aria-label="Open chat (keeps voice)"
                className={cn(voiceButtonClassName, "text-muted-foreground hover:bg-accent")}
              />
            }
          >
            <MessageSquareIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Open chat (keeps voice)</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
