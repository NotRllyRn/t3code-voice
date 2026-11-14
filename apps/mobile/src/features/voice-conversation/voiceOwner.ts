import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection } from "@t3tools/contracts";

function selectionKey(selection: ModelSelection): string {
  return JSON.stringify([
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, value }) => [id, value]),
  ]);
}

export interface VoiceOwner {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
}

/** The composer can have unsaved settings. Never retarget voice to that other identity. */
export function voiceOwner(input: {
  thread: EnvironmentThreadShell | null;
  effectiveModel: ModelSelection | null;
  driver: string | undefined;
  ready: boolean;
}): VoiceOwner | null {
  const { thread, effectiveModel, driver, ready } = input;
  if (
    !ready ||
    !thread ||
    thread.archivedAt ||
    driver !== "codex" ||
    !effectiveModel ||
    thread.providerInstanceId !== thread.modelSelection.instanceId ||
    selectionKey(thread.modelSelection) !== selectionKey(effectiveModel)
  )
    return null;
  return {
    thread,
    key: JSON.stringify([
      thread.environmentId,
      thread.id,
      selectionKey(thread.modelSelection),
      thread.runtimeMode,
      thread.interactionMode,
    ]),
  };
}
