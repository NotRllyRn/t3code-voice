import { useEffect, useSyncExternalStore } from "react";
import { liveCaptionKey, liveCaptions } from "./liveCaptions";

export interface LiveCaptionScope {
  environmentId: string;
  threadId?: string | undefined;
  draftId?: string | undefined;
}
export function useLiveCaptionRows(
  scope: LiveCaptionScope | undefined,
  canonicalMessageIds: ReadonlySet<string>,
) {
  const snapshot = useSyncExternalStore(liveCaptions.subscribe, liveCaptions.getSnapshot);
  const key = scope
    ? liveCaptionKey(scope.environmentId, scope.threadId, scope.draftId)
    : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release closed-session previews after canonical timeline history arrives.
  useEffect(() => {
    if (key && snapshot.keys.includes(key)) liveCaptions.reconcile(key, canonicalMessageIds);
  }, [key, canonicalMessageIds, snapshot]);
  if (
    !scope ||
    !snapshot.keys.includes(liveCaptionKey(scope.environmentId, scope.threadId, scope.draftId))
  )
    return null;
  const captions = snapshot.captions.filter(
    (caption) => !caption.messageId || !canonicalMessageIds.has(caption.messageId),
  );
  if (captions.length === 0 && !snapshot.overflow) return null;
  return (
    <section aria-label="Live voice captions" className="messages-timeline-row-frame">
      <div className="chat-content-lane space-y-3 py-3">
        {snapshot.overflow ? (
          <p role="status" className="text-xs text-muted-foreground">
            Earlier live previews are no longer shown. Captions are not final transcripts.
          </p>
        ) : null}
        {captions.map((caption) => (
          <div
            key={`${caption.sessionId}:${caption.role}:${caption.segmentId}`}
            data-live-caption={caption.role}
          >
            <p className="text-xs text-muted-foreground">
              {caption.role === "user" ? "You" : "Assistant"} · Live caption · not final
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">{caption.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
