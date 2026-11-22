import { environmentId, installFakeEnvironment, timelineProps } from "./testkit";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { liveCaptionKey, liveCaptions } from "../liveCaptions";
import "~/index.css";

it("keeps the existing footer node and input state as caption scope and rows change", async () => {
  using _environment = installFakeEnvironment([], { providers: [] });
  const owner = Symbol("footer identity");
  using _session = {
    [Symbol.dispose]() {
      liveCaptions.clear(owner);
    },
  };
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column";
  const props = timelineProps("footer-identity");
  const footer = <input aria-label="Retained footer" defaultValue="Draft" />;
  const scope = { environmentId, threadId: "footer-identity" };
  await using screen = await render(<MessagesTimeline {...props} footer={footer} />, { container });
  const input = screen.getByRole("textbox", { name: "Retained footer" });
  await userEvent.type(input, " preserved");
  const node = input.element();
  await act(() => {
    liveCaptions.begin(owner, liveCaptionKey(environmentId, scope.threadId));
    liveCaptions.caption(owner, {
      type: "live.caption",
      sessionId: "synthetic-session",
      role: "user",
      segmentId: "input",
      revision: 1,
      text: "Footer preview",
      committed: false,
    });
  });
  await screen.rerender(<MessagesTimeline {...props} liveCaptionScope={scope} footer={footer} />);
  await expect.element(screen.getByText("Footer preview", { exact: true })).toBeVisible();
  expect(input.element()).toBe(node);
  await expect.element(input).toHaveValue("Draft preserved");
  await act(() => liveCaptions.finish(owner));
  await expect.element(screen.getByText("Footer preview", { exact: true })).not.toBeInTheDocument();
  expect(input.element()).toBe(node);
  await screen.rerender(<MessagesTimeline {...props} footer={footer} />);
  expect(input.element()).toBe(node);
  await expect.element(input).toHaveValue("Draft preserved");
});
