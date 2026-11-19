import {
  type OrchestrationV2CreationSource,
  type OrchestrationV2VoiceMessage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
