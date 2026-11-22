import { T, useGT } from "gt-react";
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
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  readPreparedConnection,
  useEnvironmentScope,
  usePreparedConnection,
} from "../state/session";
import { useQuietThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { runEnvironmentSpeech } from "../speech/runEnvironmentSpeech";
import {
  MicIcon,
  LoaderCircleIcon,
  MicOffIcon,
  XIcon,
  SquareIcon,
  AudioLinesIcon,
  CircleAlertIcon,
  MessageSquareIcon,
} from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { browserLiveMedia } from "./liveMedia";
import { acquireLiveVoiceLock } from "./liveVoiceLock";
import { useLiveVoiceSettings } from "./liveVoiceSettings";
import { liveCaptionKey, liveCaptions } from "./liveCaptions";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { m } from "../i18n/messages";
import { matchesLiveVoiceTarget, liveVoiceTargetIsViewed } from "./liveVoicePresentation";

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
    !!navigator.locks &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

type Target = Pick<Props, "environmentId" | "threadId" | "draftId" | "draft">;
type Owner = {
  target: Target;
  controller: LiveVoiceController;
  token: symbol;
};
type Snapshot = { owner: Owner | null; voice: LiveVoiceState };
const LiveVoiceContext = createContext<{
  snapshot: Snapshot;
  start(target: Target): void;
  dismiss(): void;
  blocksDraftSend(environmentId: EnvironmentId, draftId: string | null): boolean;
} | null>(null);
const isActive = (voice: LiveVoiceState) => voice.phase !== "idle" && voice.phase !== "error";

export function LiveVoiceProvider({ children }: { children: ReactNode }) {
  const owner = useRef<Owner | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    owner: null,
    voice: INITIAL_LIVE_VOICE_STATE,
  });
  const boundTarget = snapshot.owner?.target;
  const boundEnvironmentId = boundTarget?.environmentId;
  const boundThreadId = boundTarget?.threadId;
  const boundDraftId = boundTarget?.draftId;
  const boundShell = useQuietThreadShell(
    boundEnvironmentId && boundThreadId
      ? { environmentId: boundEnvironmentId, threadId: boundThreadId }
      : null,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hand off the external Live binding only once its server shell can render the composer.
  useEffect(() => {
    if (
      !boundDraftId ||
      !boundEnvironmentId ||
      !boundThreadId ||
      !boundShell ||
      boundShell.deletedAt != null
    )
      return;
    const store = useComposerDraftStore.getState();
    const id = DraftId.make(boundDraftId);
    if (store.getDraftSession(id)?.environmentId !== boundEnvironmentId) return;
    store.markDraftThreadPromoting(id, {
      environmentId: boundEnvironmentId,
      threadId: boundThreadId,
    });
    store.finalizePromotedDraftThread(id);
  }, [boundDraftId, boundEnvironmentId, boundThreadId, boundShell]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Only app teardown releases the external session; route and visibility changes do not.
  useEffect(() => {
    const stop = () => owner.current?.controller.stop();
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      if (owner.current) {
        liveCaptions.clear(owner.current.token);
        owner.current.controller.dispose();
        owner.current = null;
      }
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The session owner forwards notification changes even when its composer is not mounted.
  useEffect(
    () =>
      useLiveVoiceSettings.subscribe((settings, previous) => {
        if (settings.notifications !== previous.notifications)
          owner.current?.controller.setNotifications(settings.notifications);
      }),
    [],
  );
  const start = (target: Target) => {
    if (owner.current && isActive(owner.current.controller.state)) return;
    if (owner.current) {
      liveCaptions.clear(owner.current.token);
      owner.current.controller.dispose();
    }
    const { environmentId, threadId, draftId } = target;
    const prepared = readPreparedConnection(environmentId);
    if (!prepared) return;
    const settings = useLiveVoiceSettings.getState();
    const preferences = { voice: settings.voice, notifications: settings.notifications };
    const devices = { microphoneId: settings.microphoneId, speakerId: settings.speakerId };
    const token = Symbol("Live owner");
    let showingCaptions = false;
    const controller = new LiveVoiceController(
      {
        resolve: m,
        acquire: acquireLiveVoiceLock,
        media: (options) => browserLiveMedia({ ...options, devices }),
        socket: (url) => new WebSocket(url),
        url: async (signal) => {
          const connection = readPreparedConnection(environmentId);
          if (!connection) throw new LiveVoiceStartupError({ reason: "connection-changed" });
          const descriptor = appAtomRegistry.get(
            serverEnvironment.configValueAtom(environmentId),
          )?.environment;
          const url = new URL(
            await runEnvironmentSpeech(getEnvironmentLiveVoiceUrl(connection, descriptor), {
              signal,
            }),
          );
          if (target.threadId) url.searchParams.set("threadId", target.threadId);
          else url.searchParams.set("draft", JSON.stringify(target.draft));
          url.searchParams.set("preferences", JSON.stringify(preferences));
          return url.toString();
        },
        event: (event) => {
          if (event.type === "live.caption") liveCaptions.caption(token, event);
          if (event.type === "live.bound" && owner.current?.controller === controller) {
            target.threadId = event.threadId;
            liveCaptions.bind(token, liveCaptionKey(environmentId, event.threadId));
            if (!threadId && draftId) {
              const store = useComposerDraftStore.getState();
              const id = DraftId.make(draftId);
              if (store.getDraftSession(id)?.environmentId === environmentId) {
                store.markDraftThreadPromoting(id, { environmentId, threadId: event.threadId });
              }
            }
          }
        },
      },
      (voice) => {
        if (owner.current?.controller !== controller) return;
        if ((voice.phase === "connecting" || voice.phase === "reconnecting") && !showingCaptions) {
          showingCaptions = true;
          liveCaptions.begin(token, liveCaptionKey(environmentId, target.threadId, draftId));
        }
        if (!isActive(voice)) {
          showingCaptions = false;
          liveCaptions.finish(token);
        }
        setSnapshot({ owner: owner.current, voice });
      },
    );
    owner.current = { target, controller, token };
    controller.setNotifications(settings.notifications);
    void controller.start();
  };
  const dismiss = () => {
    if (!owner.current || isActive(owner.current.controller.state)) return;
    liveCaptions.clear(owner.current.token);
    owner.current.controller.dispose();
    owner.current = null;
    setSnapshot({ owner: null, voice: INITIAL_LIVE_VOICE_STATE });
  };
  const blocksDraftSend = (environmentId: EnvironmentId, draftId: string | null) => {
    const current = owner.current;
    return (
      !!current &&
      !!draftId &&
      current.target.environmentId === environmentId &&
      current.target.draftId === draftId &&
      (isActive(current.controller.state) || !!current.target.threadId)
    );
  };
  return (
    <LiveVoiceContext value={{ snapshot, start, dismiss, blocksDraftSend }}>
      {children}
    </LiveVoiceContext>
  );
}

// Read the owner at send time too: keyboard and deferred sends can outlive a render.
export function useLiveVoiceDraftSendGuard() {
  return useContext(LiveVoiceContext)?.blocksDraftSend;
}

export function useLiveVoiceSessionActive() {
  const app = useContext(LiveVoiceContext);
  return !!app && isActive(app.snapshot.voice);
}

export function useLiveVoiceTargetActive(target: {
  environmentId: EnvironmentId;
  threadId?: ThreadId | undefined;
  draftId?: string | undefined;
}) {
  const app = useContext(LiveVoiceContext);
  return (
    !!app?.snapshot.owner &&
    isActive(app.snapshot.voice) &&
    matchesLiveVoiceTarget(app.snapshot.owner.target, app.snapshot.voice, target)
  );
}

export function useComposerLiveVoice({ environmentId, threadId, draftId, draft, disabled }: Props) {
  const gt = useGT();
  const app = useContext(LiveVoiceContext);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const descriptor = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment;
  const nativeLiveSupported =
    descriptor?.environmentId === environmentId && supportsEnvironmentNativeLiveVoice(descriptor);
  const target = app?.snapshot.owner?.target;
  const matches =
    !!target &&
    matchesLiveVoiceTarget(target, app!.snapshot.voice, {
      environmentId,
      threadId,
      draftId,
    });
  const occupied = !!app && isActive(app.snapshot.voice) && !matches;
  const voice = matches ? app!.snapshot.voice : INITIAL_LIVE_VOICE_STATE;
  const allowed =
    !occupied &&
    !disabled &&
    canOperate &&
    !!prepared &&
    !!app &&
    supported() &&
    nativeLiveSupported;
  const controller = {
    start: () => {
      if (allowed) app?.start({ environmentId, threadId, draftId, draft });
    },
    mute: () => {
      if (matches) app?.snapshot.owner?.controller.mute();
    },
    stop: () => {
      if (matches) app?.snapshot.owner?.controller.stop();
    },
  };
  const unavailableReason = occupied
    ? gt(
        "Only one Live voice session can run. Stop the current session before starting another thread.",
      )
    : !supported()
      ? gt(
          "Live voice requires a secure desktop browser with WebRTC, Web Locks and microphone support",
        )
      : !canOperate
        ? gt("Live voice requires permission to operate this environment")
        : !prepared
          ? gt("Connect to use live voice")
          : !descriptor
            ? gt("Waiting for this environment's live voice capabilities")
            : descriptor.environmentId !== environmentId
              ? gt("The environment connection changed. Reconnect and try live voice again.")
              : !nativeLiveSupported
                ? gt(
                    "This server does not support native live voice. Update T3 Code on this environment and reconnect.",
                  )
                : disabled
                  ? gt("Live voice is unavailable for the current composer")
                  : null;
  return {
    controller,
    voice,
    allowed,
    unavailableReason,
    environmentId,
    threadId,
    draftSubmissionBlocked: app?.blocksDraftSend(environmentId, draftId ?? null) ?? false,
    sessionActive: !!app && isActive(app.snapshot.voice),
  };
}

export function LiveVoiceSessionControls() {
  const gt = useGT();
  const app = useContext(LiveVoiceContext);
  const pathname = useLocation({ select: (location) => location.pathname });
  const targetRef = app?.snapshot.owner?.target;
  const visibleThreadId = app?.snapshot.voice.threadId ?? targetRef?.threadId;
  const targetShell = useQuietThreadShell(
    targetRef && visibleThreadId
      ? { environmentId: targetRef.environmentId, threadId: visibleThreadId }
      : null,
  );
  if (!app?.snapshot.owner || (!isActive(app.snapshot.voice) && !app.snapshot.voice.error))
    return null;
  const { target, controller } = app.snapshot.owner;
  if (
    liveVoiceTargetIsViewed(target, app.snapshot.voice, pathname) &&
    (pathname.startsWith("/draft/") || targetShell !== null)
  )
    return null;
  const threadId = app.snapshot.voice.threadId ?? target.threadId;
  const live = {
    controller: {
      start: () => app.start({ ...target }),
      stop: () => controller.stop(),
      mute: () => controller.mute(),
    },
    draftSubmissionBlocked: false,
    sessionActive: isActive(app.snapshot.voice),
    voice: app.snapshot.voice,
    allowed: true,
    unavailableReason: null,
    environmentId: target.environmentId,
    threadId,
  };
  return (
    <section
      aria-label={gt("Live voice session")}
      className="flex shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 border-t bg-background px-3 py-1.5 text-xs [-webkit-app-region:no-drag] sm:px-4"
    >
      <AudioLinesIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-muted-foreground" role="status">
        <T>Live</T> · {liveVoiceStatus(live.voice, gt)}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {threadId ? (
          <Button
            size="sm"
            variant="ghost"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: target.environmentId, threadId }}
              />
            }
          >
            <MessageSquareIcon aria-hidden="true" />
            <T>Open chat</T>
          </Button>
        ) : target.draftId ? (
          <Button
            size="sm"
            variant="ghost"
            render={
              <Link to="/draft/$draftId" params={{ draftId: DraftId.make(target.draftId) }} />
            }
          >
            <MessageSquareIcon aria-hidden="true" />
            <T>Open chat</T>
          </Button>
        ) : null}
        {live.sessionActive ? (
          <ComposerLiveVoiceControls live={live} compact />
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={live.controller.start}>
              <T>Try voice again</T>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={gt("Dismiss voice error")}
              onClick={app.dismiss}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
      {live.voice.error ? (
        <p role="alert" className="w-full break-words text-destructive">
          {live.voice.error}
        </p>
      ) : null}
    </section>
  );
}

function liveVoiceStatus(voice: LiveVoiceState, gt: ReturnType<typeof useGT>) {
  switch (voice.phase) {
    case "connecting":
      return gt("Connecting voice…");
    case "reconnecting":
      return gt("Reconnecting live voice ({attempt}/4)", { attempt: voice.recoveryAttempt });
    case "refresh_wait":
      return gt("Waiting for provider refresh");
    case "stopping":
      return gt("Stopping live voice");
    case "connected":
      return voice.muted ? gt("Mic muted") : gt("Listening");
    default:
      return gt("Voice stopped");
  }
}

type LiveVoice = ReturnType<typeof useComposerLiveVoice>;

const voiceButtonClassName =
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-50 sm:size-8 [&_svg]:size-4";

export function ComposerLiveVoiceControls({
  live,
  compact = false,
}: {
  live: LiveVoice;
  compact?: boolean;
}) {
  const gt = useGT();
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
        {compact ? (
          <Button
            type="button"
            variant={props.muted ? "outline" : "ghost"}
            size="icon-sm"
            aria-label={label}
            aria-pressed={props.pressed}
            aria-busy={props.busy || undefined}
            disabled={props.disabled}
            onClick={action}
          >
            {icon}
          </Button>
        ) : (
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
                ? "border border-border bg-muted text-foreground hover:bg-accent"
                : active
                  ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                  : "bg-message-action text-message-action-foreground hover:bg-message-action-hover",
            )}
          >
            {icon}
          </button>
        )}
      </TooltipTrigger>
      <TooltipPopup>{props.tooltip ?? label}</TooltipPopup>
    </Tooltip>
  );
  if (!active)
    return button(
      gt("Start live voice"),
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
      ? gt("Reconnecting live voice ({attempt}/4)", { attempt: voice.recoveryAttempt })
      : voice.phase === "connecting"
        ? gt("Connecting live voice")
        : voice.phase === "refresh_wait"
          ? gt("Waiting for provider refresh")
          : voice.phase === "stopping"
            ? gt("Live microphone off")
            : voice.muted
              ? gt("Unmute live microphone")
              : gt("Mute live microphone");
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
            ? voice.phase === "reconnecting"
              ? gt("Reconnecting live voice ({attempt}/4). Microphone is off; Stop is available.", {
                  attempt: voice.recoveryAttempt,
                })
              : voice.phase === "connecting"
                ? gt("Connecting live voice. Microphone is off; Stop is available.")
                : gt("Waiting for provider refresh. Microphone is off; Stop is available.")
            : microphoneLabel,
        },
      )}
      {button(
        voice.phase === "stopping" ? gt("Stopping live voice") : gt("Stop live voice"),
        () => void controller?.stop(),
        voice.phase === "stopping" ? busyIcon : <SquareIcon aria-hidden="true" />,
        {
          disabled: voice.phase === "stopping",
          busy: voice.phase === "stopping",
          tooltip:
            voice.phase === "stopping"
              ? gt("Finishing voice cleanup. Microphone and playback are off.")
              : gt("Stop live voice"),
        },
      )}
    </>
  );
}

export function ComposerLiveVoiceFeedback({ live }: { live: LiveVoice }) {
  const gt = useGT();
  const { voice, environmentId, threadId, controller, allowed } = live;
  const active = voice.phase !== "idle" && voice.phase !== "error";
  return (
    <>
      {active ? (
        <span className="px-1 text-xs text-muted-foreground">{liveVoiceStatus(voice, gt)}</span>
      ) : null}
      <span role="status" className="sr-only">
        {active
          ? voice.phase === "stopping"
            ? gt("Stopping voice. Microphone and playback are off.")
            : voice.phase === "reconnecting"
              ? gt(
                  "Reconnecting voice, attempt {attempt} of 4. Microphone is off; Stop is available.",
                  { attempt: voice.recoveryAttempt },
                )
              : voice.phase === "refresh_wait"
                ? gt(
                    "Waiting for the selected provider to refresh. You can stop voice at any time.",
                  )
                : voice.phase !== "connected"
                  ? gt("Connecting voice…")
                  : voice.muted
                    ? gt("Mic muted")
                    : gt("Listening")
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
                aria-label={gt("Live voice error")}
                className={cn(voiceButtonClassName, "text-destructive hover:bg-destructive/15")}
              />
            }
          >
            <CircleAlertIcon aria-hidden="true" />
          </PopoverTrigger>
          <PopoverPopup side="top" align="end" width="sm" padding="compact">
            <PopoverTitle>
              <T>Voice stopped</T>
            </PopoverTitle>
            <p className="my-2 max-h-40 overflow-y-auto break-words text-sm">{voice.error}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!allowed || active}
              onClick={() => void controller?.start()}
            >
              <T>Try voice again</T>
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
                aria-label={gt("Open chat (keeps voice)")}
                className={cn(voiceButtonClassName, "text-muted-foreground hover:bg-accent")}
              />
            }
          >
            <MessageSquareIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Open chat (keeps voice)</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
