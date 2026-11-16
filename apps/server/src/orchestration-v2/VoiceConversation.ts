import {
  CommandId,
  type MessageId,
  type OrchestrationV2CreationSource,
  type OrchestrationV2VoiceMessage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { voiceMessageId, voiceRecordCommandId } from "./VoiceHistory.ts";

export interface RecordVoiceMessageInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly voice: OrchestrationV2VoiceMessage;
  readonly creationSource: OrchestrationV2CreationSource;
}

/** Server-owned API. Its caller must retain the authenticated voice owner/thread binding. */
export const recordVoiceMessage = Effect.fn("VoiceConversation.recordVoiceMessage")(function* (
  input: RecordVoiceMessageInput,
) {
  const threads = yield* ThreadManagementService;
  yield* threads.getProjectThreadRecords(input, []);
  const messageId = voiceMessageId(input.role, input.voice);
  const commandId = voiceRecordCommandId([
    input.threadId,
    messageId,
    input.role,
    input.text,
    input.voice,
    input.creationSource,
  ]);
  const dispatch = yield* threads.dispatch({
    type: "voice.message.record",
    commandId,
    threadId: input.threadId,
    messageId,
    role: input.role,
    text: input.text,
    voice: input.voice,
    createdBy: input.role === "user" ? "user" : "agent",
    creationSource: input.role === "user" ? input.creationSource : "server",
  });
  return { messageId, dispatch };
});

export interface SendRecordedVoiceMessageInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly sessionId: string;
}

/** Execution-only bridge; never accepts rewritten task text or assistant output. */
export const sendRecordedVoiceMessage = Effect.fn("VoiceConversation.sendRecordedVoiceMessage")(
  function* (input: SendRecordedVoiceMessageInput) {
    const threads = yield* ThreadManagementService;
    const { messages } = yield* threads.getProjectThreadRecords(input, ["messages"], {
      messageIds: [input.messageId],
    });
    const message = messages.find((candidate) => candidate.id === input.messageId);
    const commandId = CommandId.make(`command:voice:execute:${input.messageId}`);
    if (
      message?.role !== "user" ||
      message.voice?.textKind !== "final_user_transcript" ||
      message.voice.sessionId !== input.sessionId ||
      message.voice.transcriptFinality === "application_frozen"
    ) {
      return yield* new OrchestratorDispatchError({
        commandId,
        commandType: "message.dispatch",
        cause: "No recorded user input for this voice session.",
      });
    }
    return yield* threads.sendToThread({
      projectId: input.projectId,
      threadId: input.threadId,
      commandId,
      messageId: message.id,
      text: message.text,
      attachments: [],
      mode: "queue",
      createdBy: message.createdBy,
      creationSource: message.creationSource,
    });
  },
);
