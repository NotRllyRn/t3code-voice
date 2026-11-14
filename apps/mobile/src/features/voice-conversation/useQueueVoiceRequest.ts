import { CommandId, MessageId } from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
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
  const latest = useRef(owner);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revokes callbacks held by an outstanding native confirmation before dispatch can reach a changed or unmounted thread
  useLayoutEffect(() => {
    latest.current = owner;
    return () => {
      latest.current = null;
    };
  }, [owner]);
  const start = useAtomCommand(threadEnvironment.startTurn, {
    label: "queue voice request",
    reportFailure: false,
  });
  return async (request: VoiceHandoff) => {
    const current = latest.current;
    if (
      !owner ||
      current?.key !== owner.key ||
      !request.text.trim() ||
      request.text.length > 16_000
    ) {
      throw new Error("Voice thread or model changed");
    }
    const { thread } = current;
    const result = await start({
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
    });
    if (result._tag !== "Success")
      throw new Error("Could not queue request. Retry uses the same IDs.");
  };
}
