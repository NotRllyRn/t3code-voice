import { useEffect, useEffectEvent } from "react";
import type { RuntimeRequestId } from "@t3tools/contracts";
import { randomUUID } from "../lib/utils";
import { liveQuestionAnswers } from "./liveQuestionAnswers";

export function useLiveQuestionAnswer(input: {
  environmentId: string;
  threadId: string | null;
  requestId: RuntimeRequestId | undefined;
  questionId: string | undefined;
  revision: string;
  enabled: boolean;
  answer: (questionId: string, revision: string, text: string) => void;
}) {
  const answer = useEffectEvent(input.answer);
  const { environmentId, threadId, requestId, questionId, revision, enabled } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Binds finalized speech from the external Live session to the visible question and draft revision.
  useEffect(() => {
    if (!enabled || !threadId || !requestId || !questionId) return;
    return liveQuestionAnswers.register(environmentId, threadId, {
      target: { requestId, questionId, nonce: randomUUID() },
      answer: (text) => answer(questionId, revision, text),
    });
  }, [environmentId, threadId, requestId, questionId, revision, enabled]);
}
