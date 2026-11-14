import { CommandId, MessageId } from "@t3tools/contracts";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import type { VoiceOwner } from "./voiceOwner";

export interface VoiceHandoff {
  readonly text: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
}

/** Dedicated queue-only dispatch. Does not read or send the ordinary composer draft. */
export function useQueueVoiceRequest(owner: VoiceOwner | null) {
  const ownerKey = owner?.key;
  const lifetime = useMemo(() => ({ key: ownerKey }), [ownerKey]);
  const latest = useRef<{ lifetime: typeof lifetime; cancellation: AbortController } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revokes confirmed handoffs still waiting in the local command lane when the native owner changes or unmounts
  useLayoutEffect(() => {
    const cancellation = new AbortController();
    latest.current = { lifetime, cancellation };
    return () => {
      latest.current = null;
      cancellation.abort();
    };
  }, [lifetime]);
  const start = useAtomCommand(threadEnvironment.startTurn, {
    label: "queue voice request",
    reportFailure: false,
  });
  return async (request: VoiceHandoff) => {
    const current = latest.current;
    if (
      !owner ||
      current?.lifetime !== lifetime ||
      current.cancellation.signal.aborted ||
      !request.text.trim() ||
      request.text.length > 16_000
    ) {
      throw new Error("Voice thread or model changed");
    }
    const { thread } = owner;
    const result = await start(
      {
        environmentId: thread.environmentId,
        input: {
          threadId: thread.id,
          commandId: CommandId.make(request.commandId),
          createdAt: request.createdAt,
          creationSource: "mobile",
          dispatchMode: "queue",
          resendAfterSocketLoss: false,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          message: {
            messageId: MessageId.make(request.messageId),
            role: "user",
            text: request.text,
            attachments: [],
          },
        },
      },
      { signal: current.cancellation.signal },
    );
    if (result._tag !== "Success")
      throw new Error("Could not queue request. Retry uses the same IDs.");
  };
}
