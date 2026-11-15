import { getEnvironmentRealtimeVoiceUrl } from "@t3tools/client-runtime/voice-input";
import {
  VoiceController,
  INITIAL_VOICE_STATE,
  type VoiceState,
} from "@t3tools/client-runtime/voice-conversation";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
  type ProjectId,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { MicIcon, MicOffIcon, XIcon, AudioLinesIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { browserMedia } from "./media.js";

interface Props {
  environmentId: EnvironmentId;
  threadId?: ThreadId | undefined;
  modelSelection?: ModelSelection | undefined;
  draft?:
    | {
        projectId?: ProjectId;
        modelSelection: ModelSelection;
        runtimeMode: RuntimeMode;
        interactionMode: ProviderInteractionMode;
      }
    | undefined;
  disabled: boolean;
}
function supported() {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return (
    !ios &&
    window.isSecureContext &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Binding stays on the draft until Stop: first speech can launch without losing the microphone to navigation. */
export function useComposerLiveVoice({
  environmentId,
  threadId,
  modelSelection,
  draft,
  disabled,
}: Props) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const binding = JSON.stringify({
    environmentId,
    modelSelection,
    ...(threadId ? { threadId } : { draft }),
  });
  const [snapshot, setSnapshot] = useState<{
    controller: VoiceController | null;
    value: VoiceState;
  }>({ controller: null, value: INITIAL_VOICE_STATE });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- This effect owns and disposes the external microphone/socket, including StrictMode replay.
  useEffect(() => {
    if (!prepared) {
      // eslint-disable-next-line react/set-state-in-effect -- Clear the disposed external audio owner on disconnect.
      setSnapshot({ controller: null, value: INITIAL_VOICE_STATE });
      return;
    }
    const owner = new VoiceController(
      {
        continuous: true,
        media: browserMedia,
        socket: (url) => new WebSocket(url),
        url: async (signal) => {
          const url = new URL(
            await runEnvironmentSpeech(getEnvironmentRealtimeVoiceUrl(prepared), { signal }),
          );
          url.searchParams.set("continuous", "1");
          const target = JSON.parse(binding) as { threadId?: string; draft?: Props["draft"] };
          if (target.threadId) url.searchParams.set("threadId", target.threadId);
          else url.searchParams.set("draft", JSON.stringify(target.draft));
          return url.toString();
        },
      },
      (value) => setSnapshot({ controller: owner, value }),
    );
    setSnapshot({ controller: owner, value: INITIAL_VOICE_STATE });
    return () => owner.dispose();
  }, [prepared, binding]);
  const controller = snapshot.controller;
  const voice = snapshot.value;
  const allowed = !disabled && canOperate && !!prepared && !!controller && supported();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Permission/connection loss must release the external audio resources.
  useEffect(() => {
    if (!allowed) void controller?.stop();
  }, [allowed, controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Browser visibility events release microphone and playback.
  useEffect(() => {
    const stop = () => {
      void controller?.stop();
    };
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
    ? "Live voice requires a secure desktop browser with microphone support"
    : !canOperate
      ? "Live voice requires permission to operate this environment"
      : !prepared
        ? "Connect to use live voice"
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
      pressed?: boolean;
      muted?: boolean;
      busy?: boolean;
      tooltip?: string | null;
    } = {},
  ) => (
    <Tooltip>
      <TooltipTrigger
        render={
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
          />
        }
      >
        {icon}
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
  return (
    <>
      {button(
        voice.muted ? "Unmute live microphone" : "Mute live microphone",
        () => void controller?.mute(),
        voice.muted ? <MicOffIcon aria-hidden="true" /> : <MicIcon aria-hidden="true" />,
        {
          disabled: voice.phase !== "active" || voice.busy,
          pressed: voice.muted,
          muted: voice.muted,
          busy: voice.busy,
        },
      )}
      {button("Stop live voice", () => void controller?.stop(), <XIcon aria-hidden="true" />)}
    </>
  );
}

export function VoicePanel({ live }: { live: LiveVoice }) {
  const { voice, environmentId, threadId } = live;
  const active = voice.phase !== "idle" && voice.phase !== "error";
  if (!voice.error && !voice.transcript && !voice.reply && !active && !voice.threadId) return null;
  return (
    <div aria-label="Live voice" className="mx-3 mb-2 space-y-1 text-xs sm:mx-4">
      {active ? (
        <p
          role="status"
          className="text-muted-foreground"
          aria-busy={voice.phase !== "active" || voice.busy}
        >
          {voice.phase !== "active" ? "Connecting voice…" : voice.muted ? "Mic muted" : "Listening"}
        </p>
      ) : null}
      {voice.error ? (
        <p role="alert" className="break-words text-destructive">
          {voice.error}
        </p>
      ) : null}
      {voice.threadId && !threadId ? (
        <Link to="/$environmentId/$threadId" params={{ environmentId, threadId: voice.threadId }}>
          Open chat (stops voice)
        </Link>
      ) : null}
      {voice.transcript || voice.reply ? (
        <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
          {voice.transcript ? (
            <p>
              <span className="font-medium">
                You
                {voice.transcriptStatus === "live"
                  ? " (live, unsaved)"
                  : voice.transcriptStatus === "saving"
                    ? " (saving)"
                    : ""}
                :{" "}
              </span>
              {voice.transcript}
            </p>
          ) : null}
          {voice.reply ? (
            <p>
              <span className="font-medium">
                Voice ({voice.replyPartial ? "generating" : "generated"}):{" "}
              </span>
              {voice.reply}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
