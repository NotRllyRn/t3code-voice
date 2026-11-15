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
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { Button } from "../components/ui/button";
import { browserMedia } from "./media.js";

interface Props {
  environmentId: EnvironmentId;
  threadId?: ThreadId | undefined;
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
export function VoicePanel({ environmentId, threadId, draft, disabled }: Props) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const binding = JSON.stringify(threadId ? { threadId } : { draft });
  const [snapshot, setSnapshot] = useState<{
    controller: VoiceController | null;
    value: VoiceState;
  }>({ controller: null, value: INITIAL_VOICE_STATE });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- This effect owns and disposes the external microphone/socket, including StrictMode replay.
  useEffect(() => {
    if (!prepared) return;
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
    // eslint-disable-next-line react/set-state-in-effect -- Publish the newly acquired external audio owner after StrictMode cleanup.
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
  const canStart = voice.phase === "idle" || voice.phase === "error";
  const running = voice.phase === "active";
  return (
    <section
      aria-label="Live voice for T3 agent"
      className="mx-3 mb-2 space-y-2 rounded-lg border border-border/60 bg-muted/20 p-2 text-xs sm:mx-4"
    >
      <div className="flex flex-wrap items-center gap-1">
        {canStart ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!allowed}
            onClick={() => void controller?.start()}
          >
            Start voice
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!running || voice.busy}
              aria-pressed={voice.muted}
              onClick={() => void controller?.mute()}
            >
              {voice.muted ? "Unmute mic" : "Mute mic"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void controller?.stop()}
            >
              Stop voice
            </Button>
          </>
        )}
        <span role="status">
          {voice.muted
            ? "Mic muted"
            : running
              ? "Listening · speak to interrupt audio"
              : voice.phase}
          {voice.agentStatus ? ` · Agent: ${voice.agentStatus}` : ""}
        </span>
      </div>
      <p className="text-muted-foreground">
        Prototype · Web/macOS. Speech uses this environment’s Realtime service and delegates work to
        your selected T3 Codex thread. Normal permissions stay in chat. Stop voice stops audio, not
        coding.
      </p>
      {!threadId && (
        <p className="text-muted-foreground">
          First request creates a normal thread in{" "}
          {draft?.projectId ? "the selected project" : "managed No project (Scratch)"}. Stay here
          while speaking; open its chat to answer permissions or questions.
        </p>
      )}
      {voice.threadId && !threadId ? (
        <Link to="/$environmentId/$threadId" params={{ environmentId, threadId: voice.threadId }}>
          Open coding thread (stops voice)
        </Link>
      ) : null}
      {!supported() ? (
        <p>
          Use a secure desktop browser with microphone and AudioWorklet support. Native iOS is not
          supported.
        </p>
      ) : null}
      {disabled ? <p>Select one available Codex model and finish dictation first.</p> : null}
      {voice.error ? (
        <p role="alert" className="text-destructive">
          {voice.error}
        </p>
      ) : null}
      {voice.transcript ? (
        <div className="max-h-24 overflow-auto whitespace-pre-wrap">
          <strong>You said: </strong>
          {voice.transcript}
        </div>
      ) : null}
      {voice.reply ? (
        <div className="max-h-24 overflow-auto whitespace-pre-wrap">
          <strong>Voice: </strong>
          {voice.reply}
        </div>
      ) : null}
    </section>
  );
}
