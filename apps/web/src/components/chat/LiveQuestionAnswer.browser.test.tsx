import { liveQuestionAnswers } from "../../voice/liveQuestionAnswers";
const { command } = vi.hoisted(() => ({
  command: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => command) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
import {
  EnvironmentId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests, usePendingUserInputDraft } from "./usePendingThreadRequests";

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function questionProjection(threadId: ThreadId, requestIds = ["first", "second"]) {
  const projection = makeThreadProjectionFixture();
  return {
    ...projection,
    thread: { ...projection.thread, id: threadId },
    runtimeRequests: requestIds.map((id) => ({
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(id),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: projection.updatedAt,
      resolvedAt: null,
    })),
    turnItems: requestIds.map((id, ordinal) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: NodeId.make(id),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: projection.updatedAt,
      completedAt: projection.updatedAt,
      updatedAt: projection.updatedAt,
      type: "user_input_request" as const,
      requestId: RuntimeRequestId.make(id),
      questions: prompt.questions,
    })),
  } satisfies OrchestrationV2ThreadProjection;
}

interface ProbeProps {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  loading?: boolean;
  draftTarget?: DraftId;
}

function useProbeRequests({ environmentId, projection, loading = false, draftTarget }: ProbeProps) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const requests = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    serverProjection: loading ? null : projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: draftTarget ?? { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: (target, prompt) =>
      useComposerDraftStore.getState().setPrompt(target, prompt),
    promptRef,
    composerRef,
    setThreadError: () => {},
  });
  const draft = usePendingUserInputDraft({
    environmentId,
    activeThreadId: projection.thread.id,
    activePendingUserInput: requests.activePendingUserInput,
    supportsQuestionAttachments: false,
  });
  return { ...requests, ...draft };
}

let requests: ReturnType<typeof useProbeRequests>;

function PendingRequestsProbe(props: ProbeProps) {
  const state = useProbeRequests(props);
  useLayoutEffect(() => {
    requests = state;
  });
  return null;
}

it("final spoken custom answers advance the current card and submit once through its ordinary response command", async () => {
  command.mockClear();
  const environmentId = EnvironmentId.make("voice-answer-env");
  const projection = questionProjection(ThreadId.make("voice-answer-thread"), ["voice-card"]);
  await using _screen = await render(
    <PendingRequestsProbe environmentId={environmentId} projection={projection} />,
  );
  const answer = async (text: string) => {
    const target = liveQuestionAnswers.get(environmentId, projection.thread.id)!;
    expect(target).not.toBeNull();
    await act(() => liveQuestionAnswers.answer(environmentId, projection.thread.id, target, text));
    await act(() =>
      liveQuestionAnswers.answer(environmentId, projection.thread.id, target, "duplicate"),
    );
  };
  await answer("Deep blue");
  expect(requests.activePendingQuestionIndex).toBe(1);
  expect(command).not.toHaveBeenCalled();
  await act(() => requests.onSelectActivePendingUserInputOption("question-1", "Incremental"));
  await act(() => requests.onAdvanceActivePendingUserInput());
  await answer("Keep the original layout");
  expect(command).toHaveBeenCalledTimes(1);
  expect(command.mock.calls[0]?.[0]).toMatchObject({
    environmentId,
    input: {
      threadId: projection.thread.id,
      requestId: "voice-card",
      answers: {
        "question-0": "Deep blue",
        "question-1": "Incremental",
        "question-2": "Keep the original layout",
      },
    },
  });
});

it("ignores a transcript captured before typing or changing the visible question", async () => {
  command.mockClear();
  const environmentId = EnvironmentId.make("voice-stale-env");
  const projection = questionProjection(ThreadId.make("voice-stale-thread"), ["voice-card"]);
  await using _screen = await render(
    <PendingRequestsProbe environmentId={environmentId} projection={projection} />,
  );
  const target = liveQuestionAnswers.get(environmentId, projection.thread.id)!;
  await act(() =>
    requests.onChangeActivePendingUserInputCustomAnswer("question-0", "Typed answer"),
  );
  await act(() =>
    liveQuestionAnswers.answer(environmentId, projection.thread.id, target, "Stale speech"),
  );
  expect(requests.activePendingDraftAnswers["question-0"]?.customAnswer).toBe("Typed answer");
  expect(requests.activePendingQuestionIndex).toBe(0);
  const next = liveQuestionAnswers.get(environmentId, projection.thread.id)!;
  await _screen.rerender(null);
  liveQuestionAnswers.answer(environmentId, projection.thread.id, next, "After navigation");
  expect(command).not.toHaveBeenCalled();
});
