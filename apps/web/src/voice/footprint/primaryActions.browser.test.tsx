import "~/index.css";

import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ComposerPrimaryActions } from "../../components/chat/ComposerPrimaryActions";

function setup() {
  return {
    compact: true,
    canOperateThread: true,
    pendingAction: null,
    isRunning: true,
    canInterrupt: true,
    canResume: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    onResume: vi.fn(),
    onSubmitMessage: vi.fn(),
  } satisfies ComponentProps<typeof ComposerPrimaryActions>;
}

it.each([false, true])(
  "keeps voice controls separate from coding stop and question submission (question: %s)",
  async (question) => {
    const props = setup();
    const submit = vi.fn();
    const stopVoice = vi.fn();
    const muteVoice = vi.fn();
    await using screen = await render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ComposerPrimaryActions
          {...props}
          pendingAction={
            question
              ? {
                  questionIndex: 0,
                  isLastQuestion: true,
                  canAdvance: true,
                  isResponding: false,
                  isComplete: true,
                }
              : null
          }
          liveVoice={{
            active: true,
            controls: (
              <>
                <button type="button" onClick={muteVoice}>
                  Mute live microphone
                </button>
                <button type="button" onClick={stopVoice}>
                  Stop live voice
                </button>
              </>
            ),
          }}
        />
      </form>,
    );
    const click = (name: string) =>
      act(() =>
        (screen.getByRole("button", { name, exact: true }).element() as HTMLButtonElement).click(),
      );
    await click("Mute live microphone");
    await click("Stop live voice");
    expect(muteVoice).toHaveBeenCalledTimes(1);
    expect(stopVoice).toHaveBeenCalledTimes(1);
    expect(props.onInterrupt).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await click("Stop generation");
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    if (question) {
      await click("Submit");
      expect(submit).toHaveBeenCalledTimes(1);
    }
  },
);
