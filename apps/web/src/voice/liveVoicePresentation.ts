import type { LiveVoiceState } from "@t3tools/client-runtime/voice-conversation";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isThreadRoutePathname } from "../threadRoutes";

type Target = {
  environmentId: EnvironmentId;
  threadId?: ThreadId | undefined;
  draftId?: string | undefined;
};

export function matchesLiveVoiceTarget(target: Target, voice: LiveVoiceState, view: Target) {
  return (
    target.environmentId === view.environmentId &&
    (view.threadId
      ? (voice.threadId ?? target.threadId) === view.threadId
      : !!view.draftId && target.draftId === view.draftId)
  );
}

export function liveVoiceTargetIsViewed(target: Target, voice: LiveVoiceState, pathname: string) {
  const threadId = voice.threadId ?? target.threadId;
  if (
    threadId &&
    isThreadRoutePathname(pathname, {
      environmentId: target.environmentId,
      threadId,
    })
  )
    return true;
  return (
    !!target.draftId &&
    pathname.replace(/\/$/, "") === `/draft/${encodeURIComponent(target.draftId)}`
  );
}
