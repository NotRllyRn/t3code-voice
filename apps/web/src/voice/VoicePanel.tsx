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
import {
  MicIcon,
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

export function ComposerLiveVoiceFeedback({ live }: { live: LiveVoice }) {
  const { voice, environmentId, threadId, controller, allowed } = live;
  const active = voice.phase !== "idle" && voice.phase !== "error";
  return (
    <>
      <span role="status" className="sr-only">
        {active
          ? voice.phase !== "active"
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
                aria-label="Open chat (stops voice)"
                className={cn(voiceButtonClassName, "text-muted-foreground hover:bg-accent")}
              />
            }
          >
            <MessageSquareIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>Open chat (stops voice)</TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
