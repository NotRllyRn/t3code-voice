import { T, useGT } from "gt-react";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { TimelineEntry } from "../session-logic";
import { liveCaptionKey, liveCaptions } from "./liveCaptions";

export interface LiveCaptionScope {
  environmentId: string;
  threadId?: string | undefined;
  draftId?: string | undefined;
}
function useLiveCaptionRows(
  scope: LiveCaptionScope | undefined,
  canonicalMessageIds: ReadonlySet<string>,
) {
  const gt = useGT();
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
    <section aria-label={gt("Live voice captions")} className="messages-timeline-row-frame">
      <div className="chat-content-lane space-y-3 py-3">
        {snapshot.overflow ? (
          <p role="status" className="text-xs text-muted-foreground">
            <T>Earlier live previews are no longer shown. Captions are not final transcripts.</T>
          </p>
        ) : null}
        {captions.map((caption) => (
          <div
            key={`${caption.sessionId}:${caption.role}:${caption.segmentId}`}
            data-live-caption={caption.role}
          >
            <p className="text-xs text-muted-foreground">
              {caption.role === "user"
                ? gt("You · Live caption · not final")
                : gt("Assistant · Live caption · not final")}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">{caption.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function useLiveCaptionFooter(
  scope: LiveCaptionScope | undefined,
  entries: ReadonlyArray<TimelineEntry>,
  footer: ReactNode,
) {
  const rows = useLiveCaptionRows(
    scope,
    new Set(entries.flatMap((entry) => (entry.kind === "message" ? [entry.message.id] : []))),
  );
  return rows || footer ? (
    <>
      {rows}
      {footer}
    </>
  ) : null;
}
