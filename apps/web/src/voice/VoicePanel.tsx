import { getEnvironmentRealtimeVoiceUrl } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentScope, usePreparedConnection } from "../state/session";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import { Button } from "../components/ui/button";
import { VoiceController, INITIAL_VOICE_STATE, type VoiceState } from "./controller.ts";
import { pcmMedia } from "./media.js";

export interface VoiceHandoff {
  text: string;
  commandId: string;
  messageId: string;
}
interface Props {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  disabled: boolean;
  onQueue: (request: VoiceHandoff) => Promise<void>;
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

/** Mounted with an owner key by the composer. All audio and context die with that identity. */
export function VoicePanel(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-3 mb-2 rounded-lg border border-border/60 bg-muted/20 p-2 text-xs sm:mx-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Close voice conversation" : "Voice conversation"}
      </Button>
      {open ? <VoicePanelSession {...props} /> : null}
    </div>
  );
}

function VoicePanelSession({ environmentId, threadId, disabled, onQueue }: Props) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [snapshot, setSnapshot] = useState<{
    controller: VoiceController | null;
    value: VoiceState;
  }>({ controller: null, value: INITIAL_VOICE_STATE });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Each effect setup owns a fresh disposable audio session, including StrictMode replay.
  useEffect(() => {
    if (!prepared) return;
    const owner = new VoiceController(
      {
        microphone: () =>
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          }),
        media: pcmMedia,
        socket: (url) => new WebSocket(url),
        url: async (signal) => {
          const url = new URL(
            await runEnvironmentSpeech(getEnvironmentRealtimeVoiceUrl(prepared), { signal }),
          );
          url.searchParams.set("threadId", threadId);
          return url.toString();
        },
      },
      (value) => setSnapshot({ controller: owner, value }),
    );
    // Publish the newly acquired external controller, including after StrictMode replay.
    // eslint-disable-next-line react/set-state-in-effect
    setSnapshot({ controller: owner, value: INITIAL_VOICE_STATE });
    return () => owner.dispose();
  }, [prepared, threadId]);
  const controller = snapshot.controller;
  const voice = snapshot.value;
  const [request, setRequest] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const retry = useRef<VoiceHandoff | null>(null);
  const sending = useRef(false);
  const allowed = !disabled && canOperate && !!prepared && !!controller && supported();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Permission/connection loss must stop the external microphone and transport.
  useEffect(() => {
    if (!allowed) void controller?.stop();
  }, [allowed, controller]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Browser visibility events release the external audio session.
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
  const edit = (text: string) => {
    setRequest(text);
    setSendState("idle");
    retry.current = null;
  };
  const queue = async () => {
    const text = request.trim();
    if (!allowed || !text || text.length > 16_000 || sending.current || sendState === "sent")
      return;
    const handoff =
      retry.current?.text === text
        ? retry.current
        : {
            text,
            commandId: SecureRandom.uuidV4Unsafe(),
            messageId: SecureRandom.uuidV4Unsafe(),
          };
    retry.current = handoff;
    sending.current = true;
    setSendState("sending");
    try {
      await onQueue(handoff);
      setSendState("sent");
    } catch {
      setSendState("failed");
    } finally {
      sending.current = false;
    }
  };
  const running = voice.phase === "active";
  const canStart = voice.phase === "idle" || voice.phase === "error";
  return (
    <section aria-label="Separate voice conversation" className="mt-2 space-y-2">
      <p className="text-muted-foreground">
        Separate context. No code or chat history is shared. Audio goes through this environment’s
        configured Realtime service. Push to talk; Stop releases the microphone. Web and macOS only.
      </p>
      <p role="status">
        Voice: {voice.recording ? "recording (14 second limit)" : voice.phase}
        {voice.muted ? " · microphone muted" : ""}
      </p>
      {!supported() ? (
        <p>
          Voice requires a secure desktop browser with AudioWorklet. Native iOS voice is not
          implemented.
        </p>
      ) : null}
      {disabled ? (
        <p>
          Use a saved Codex thread with its current model selected. Finish dictation or pending
          input first.
        </p>
      ) : null}
      {voice.error ? (
        <p role="alert" className="text-destructive">
          {voice.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!allowed || !canStart}
          onClick={() => void controller?.start()}
        >
          Start voice
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!allowed || !running || voice.busy || voice.muted}
          onClick={() => void (voice.recording ? controller?.finish() : controller?.record())}
        >
          {voice.recording ? "Send voice turn" : "Record turn"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!running || voice.busy}
          aria-pressed={voice.muted}
          onClick={() => controller?.mute()}
        >
          {voice.muted ? "Unmute mic" : "Mute mic"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!running || voice.busy}
          onClick={() => void controller?.interrupt()}
        >
          Interrupt voice
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={canStart}
          onClick={() => void controller?.stop()}
        >
          Stop voice
        </Button>
      </div>
      {voice.transcript ? (
        <div className="max-h-24 overflow-auto whitespace-pre-wrap">
          <strong>You said: </strong>
          {voice.transcript}
        </div>
      ) : null}
      {voice.reply ? (
        <div className="max-h-24 overflow-auto whitespace-pre-wrap">
          <strong>Voice reply: </strong>
          {voice.reply}
        </div>
      ) : null}
      <label className="block">
        Review a coding request
        <textarea
          aria-label="Coding request from voice"
          className="mt-1 block min-h-20 w-full rounded-md border border-border bg-background p-2 text-sm"
          value={request}
          maxLength={16_000}
          disabled={sendState === "sending"}
          onChange={(e) => edit(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!voice.transcript || sendState === "sending"}
          onClick={() => edit(voice.transcript)}
        >
          Use my transcript
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!allowed || !request.trim() || sendState === "sending" || sendState === "sent"}
          onClick={() => void queue()}
        >
          Confirm and queue to coding thread
        </Button>
      </div>
      <p className="text-muted-foreground">
        Only the reviewed text above is sent. Coding keeps running; normal queue and approval rules
        apply.
      </p>
      {sendState === "sent" ? <p role="status">Request queued to this coding thread.</p> : null}
      {sendState === "failed" ? (
        <p role="alert">
          Could not confirm delivery. Retry uses the same request identity; do not manually send a
          duplicate.
        </p>
      ) : null}
    </section>
  );
}
