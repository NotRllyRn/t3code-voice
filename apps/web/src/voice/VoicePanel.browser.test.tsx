import { StrictMode } from "react";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { render } from "../../test/render";
import { VoicePanel } from "./VoicePanel";

vi.mock("../state/session", () => {
  const prepared = {};
  return {
    usePreparedConnection: () => Option.some(prepared),
    useEnvironmentScope: () => true,
  };
});

it("starts after StrictMode replay and releases late grants on close and owner change", async () => {
  const grants: Array<(stream: MediaStream) => void> = [];
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(() => new Promise((resolve) => grants.push(resolve)));
  const stopped = vi.fn();
  const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream;
  const panel = (owner: string) => (
    <StrictMode>
      <VoicePanel
        key={owner}
        environmentId={EnvironmentId.make("env_voice")}
        threadId={ThreadId.make(owner)}
        disabled={false}
        onQueue={async () => {}}
      />
    </StrictMode>
  );
  // The panel owns only audio resources, not navigation.
  await using screen = await render(panel("thread_1"), { router: false });
  await userEvent.click(screen.getByRole("button", { name: "Voice conversation", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Start voice", exact: true }));
  await expect.element(screen.getByRole("status")).toHaveTextContent("Voice: starting");
  expect(microphone).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Start voice", exact: true }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Close voice conversation" }));
  grants[0]!(stream);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Voice conversation", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Start voice", exact: true }));
  expect(microphone).toHaveBeenCalledTimes(2);
  await screen.rerender(panel("thread_2"));
  grants[1]!(stream);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(2));
  await expect
    .element(screen.getByRole("button", { name: "Voice conversation", exact: true }))
    .toBeVisible();
});
