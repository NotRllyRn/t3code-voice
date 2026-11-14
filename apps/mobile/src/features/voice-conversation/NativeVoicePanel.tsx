import { useIsFocused } from "@react-navigation/native";
import { getEnvironmentRealtimeVoiceUrl } from "@t3tools/client-runtime/voice-input";
import { INITIAL_VOICE_STATE, VoiceController } from "@t3tools/client-runtime/voice-conversation";
import * as Option from "effect/Option";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { createVoiceSocket, voiceSocketAvailable } from "../../native/nativeWebSocket";
import {
  createNativeVoiceMedia,
  nativeVoiceAvailable,
  prepareVoiceCrypto,
} from "../../native/voiceConversation";
import { usePreparedConnection } from "../../state/session";
import { runSpeech } from "../voice-input/voiceDestination";
import type { VoiceHandoff } from "./useQueueVoiceRequest";
import type { VoiceOwner } from "./voiceOwner";

export interface NativeVoicePanelProps {
  owner: VoiceOwner;
  disabled?: boolean;
  onQueue: (request: VoiceHandoff) => Promise<void>;
}

export function NativeVoicePanel(props: NativeVoicePanelProps) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [open, setOpen] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to native app visibility so a suspended screen cannot keep a voice session mounted
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  if (Platform.OS !== "ios") return null;
  return (
    <View className="px-3 py-2">
      <Button
        label={open ? "Close voice conversation" : "Voice conversation"}
        tone="text"
        onPress={() => setOpen(!open)}
      />
      {open && focused && foreground ? <VoiceSession key={props.owner.key} {...props} /> : null}
    </View>
  );
}

function VoiceSession({ owner, disabled, onQueue }: NativeVoicePanelProps) {
  const prepared = Option.getOrNull(usePreparedConnection(owner.thread.environmentId));
  const [snapshot, setSnapshot] = useState({
    controller: null as VoiceController | null,
    value: INITIAL_VOICE_STATE,
  });
  const [request, setRequest] = useState("");
  const [sendState, setSendState] = useState("idle");
  const [isSending, setIsSending] = useState(false);
  const retry = useRef<VoiceHandoff | null>(null);
  const sending = useRef(false);
  const revision = useRef(0);
  const live = useRef(true);
  const enabled = useRef(false);
  const available = nativeVoiceAvailable && voiceSocketAvailable;
  const allowed = !disabled && !!prepared && available;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revokes the guard read by an outstanding native confirmation or connection before another UI action can run
  useLayoutEffect(() => {
    enabled.current = allowed;
  }, [allowed]);

  // Each setup owns a disposable external controller, including StrictMode replay.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the shared voice controller and its native media/socket lifecycle until unmount
  useEffect(() => {
    if (!prepared || !available) return;
    live.current = true;
    prepareVoiceCrypto();
    const controller = new VoiceController(
      {
        media: createNativeVoiceMedia,
        socket: createVoiceSocket,
        url: async (signal) => {
          const url = new URL(
            await runSpeech(
              getEnvironmentRealtimeVoiceUrl(prepared),
              signal,
              () => live.current && enabled.current,
            ),
          );
          url.searchParams.set("threadId", owner.thread.id);
          return url.toString();
        },
      },
      (value) => setSnapshot({ controller, value }),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- publishes the newly owned native controller before any Start action can use it
    setSnapshot({ controller, value: INITIAL_VOICE_STATE });
    return () => {
      live.current = false;
      retry.current = null;
      revision.current++;
      controller.dispose();
    };
  }, [prepared, owner.thread.id, available]);
  const controller = snapshot.controller;
  const voice = snapshot.value;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revokes native audio/socket resources when another recorder or pending input disables voice
  useEffect(() => {
    if (!allowed) {
      retry.current = null;
      revision.current++;
      void controller?.stop();
    }
  }, [allowed, controller]);

  const edit = (text: string) => {
    revision.current++;
    retry.current = null;
    setRequest(text);
    setSendState("idle");
  };
  const queue = async () => {
    const text = request.trim();
    if (
      !allowed ||
      !controller ||
      !text ||
      text.length > 16_000 ||
      sending.current ||
      sendState === "sent"
    )
      return;
    const version = revision.current;
    sending.current = true;
    setIsSending(true);
    setSendState("confirming");
    const confirmAndSend = async () => {
      const confirmed = await new Promise<boolean>((resolve) =>
        Dialog.alert(
          "Queue this coding request?",
          text,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Confirm and queue", onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      );
      if (live.current && enabled.current && version === revision.current) {
        if (!confirmed) setSendState("idle");
        else {
          const handoff = retry.current ?? {
            text,
            commandId: uuidv4(),
            messageId: uuidv4(),
            createdAt: new Date().toISOString(),
          };
          retry.current = handoff;
          setSendState("sending");
          await onQueue(handoff);
          if (live.current && version === revision.current) setSendState("sent");
        }
      }
    };
    await confirmAndSend().catch(() => {
      if (live.current && version === revision.current) setSendState("failed");
    });
    sending.current = false;
    if (live.current) setIsSending(false);
  };
  const running = voice.phase === "active";
  const canStart = voice.phase === "idle" || voice.phase === "error";
  return (
    <View className="gap-2">
      <Text className="text-xs text-muted-foreground">
        Separate context; no code or chat history is shared. Push to talk, not always listening.
        Audio uses this environment’s configured Realtime service. No automatic coding or spoken
        coding results.
      </Text>
      {!available ? (
        <Text accessibilityRole="alert">
          Voice unavailable. Rebuild the iOS client with the native voice modules.
        </Text>
      ) : null}
      {disabled ? <Text>Finish dictation or pending input first.</Text> : null}
      <Text accessibilityLiveRegion="polite">
        Voice: {voice.recording ? "recording (14 second limit)" : voice.phase}
        {voice.muted ? " · microphone muted" : ""}
      </Text>
      {voice.error ? <Text accessibilityRole="alert">{voice.error}</Text> : null}
      <View className="flex-row flex-wrap gap-1">
        <Button
          label="Start voice"
          disabled={!allowed || !controller || !canStart}
          onPress={() => void controller?.start()}
        />
        <Button
          label={voice.recording ? "Send voice turn" : "Record turn"}
          disabled={!allowed || !running || voice.busy || voice.muted}
          onPress={() => void (voice.recording ? controller?.finish() : controller?.record())}
        />
        <Button
          label={voice.muted ? "Unmute mic" : "Mute mic"}
          disabled={!running || voice.busy}
          onPress={() => void controller?.mute()}
        />
        <Button
          label="Interrupt voice"
          disabled={!running || voice.busy}
          onPress={() => void controller?.interrupt()}
        />
        <Button label="Stop voice" disabled={canStart} onPress={() => void controller?.stop()} />
      </View>
      {voice.transcript ? <Text>You said: {voice.transcript}</Text> : null}
      {voice.reply ? <Text>Voice reply: {voice.reply}</Text> : null}
      <Button
        label="Use transcript as request"
        disabled={!voice.transcript || isSending}
        onPress={() => edit(voice.transcript)}
      />
      <AppTextInput
        accessibilityLabel="Coding request to review"
        placeholder="Review or type a coding request"
        multiline
        maxLength={16_000}
        value={request}
        onChangeText={edit}
      />
      <Button
        label={
          sendState === "failed" ? "Retry confirmed queue request" : "Review and queue request"
        }
        disabled={!allowed || !request.trim() || isSending || sendState === "sent"}
        onPress={() => void queue()}
      />
      <Text accessibilityLiveRegion="polite">
        {sendState === "sent"
          ? "Queued. Check the thread for coding progress."
          : sendState === "failed"
            ? "Queue failed. Retry preserves the request IDs."
            : "Nothing is sent to coding until you confirm."}
      </Text>
    </View>
  );
}
