import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { createElement } from "react";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import {
  ComposerLiveVoiceControls,
  ComposerLiveVoiceFeedback,
  useComposerLiveVoice,
} from "../../voice/VoicePanel";

export function useChatComposerLiveVoice(input: {
  readonly environmentId: EnvironmentId;
  readonly routeKind: "draft" | "server";
  readonly activeProjectId: ProjectId | null;
  readonly activeThreadId: ThreadId | null;
  readonly draftId: string | null;
  readonly selectedModelSelection: ModelSelection;
  readonly selectedProviderEntry:
    | { readonly snapshot: { readonly enabled: boolean } }
    | null
    | undefined;
  readonly multipleModelSelections: unknown;
  readonly providerStatuses: ReadonlyArray<{
    readonly enabled: boolean;
    readonly liveVoiceAvailable?: boolean | undefined;
  }>;
  readonly compatibleRuntimeMode: RuntimeMode;
  readonly voiceInputActive: boolean;
  readonly canOperateThread: boolean;
  readonly environmentUnavailable: unknown;
  readonly projectSelectionRequired: boolean;
  readonly activeThreadModelSelection: ModelSelection | null | undefined;
  readonly selectedInstanceId: ProviderInstanceId | undefined;
  readonly selectedModel: string;
}) {
  const gt = useGT();
  const available =
    input.selectedProviderEntry?.snapshot.enabled === true &&
    input.multipleModelSelections === null &&
    input.providerStatuses.some(
      (provider) => provider.enabled && provider.liveVoiceAvailable === true,
    );
  const liveVoice = useComposerLiveVoice({
    environmentId: input.environmentId,
    modelSelection: input.selectedModelSelection,
    draftId: input.draftId ?? undefined,
    threadId: input.routeKind === "server" ? (input.activeThreadId ?? undefined) : undefined,
    draft:
      input.routeKind === "draft"
        ? {
            ...(input.activeProjectId ? { projectId: input.activeProjectId } : {}),
            ...(input.activeThreadId ? { threadId: input.activeThreadId } : {}),
            modelSelection: input.selectedModelSelection,
            runtimeMode: input.compatibleRuntimeMode,
            interactionMode: DEFAULT_INTERACTION_MODE,
          }
        : undefined,
    disabled:
      !available ||
      input.voiceInputActive ||
      !input.canOperateThread ||
      input.environmentUnavailable !== null ||
      input.projectSelectionRequired ||
      (input.routeKind === "server" &&
        (input.activeThreadModelSelection?.instanceId !== input.selectedInstanceId ||
          input.activeThreadModelSelection?.model !== input.selectedModel)),
  });
  const active = liveVoice.voice.phase !== "idle" && liveVoice.voice.phase !== "error";
  const feedbackVisible =
    !!liveVoice.voice.error || (!input.activeThreadId && !!liveVoice.voice.threadId);
  return {
    active,
    keepsFooterVisible: active || feedbackVisible,
    sessionActive: liveVoice.sessionActive,
    draftSubmissionBlocked: liveVoice.draftSubmissionBlocked,
    sendDisabledReason: liveVoice.draftSubmissionBlocked ? gt("Connecting voice…") : null,
    feedback: createElement(ComposerLiveVoiceFeedback, { live: liveVoice }),
    primaryActions:
      available || active
        ? { active, controls: createElement(ComposerLiveVoiceControls, { live: liveVoice }) }
        : undefined,
  };
}
