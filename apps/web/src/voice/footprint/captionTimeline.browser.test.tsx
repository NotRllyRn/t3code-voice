import { environmentId, installFakeEnvironment, normalMessage, timelineProps } from "./testkit";
import { MessageId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { liveCaptionKey, liveCaptions, type LiveCaption } from "../liveCaptions";
import "~/index.css";

function session(threadId?: string, draftId?: string) {
  const environment = installFakeEnvironment([], { providers: [] });
  const owner = Symbol("caption regression");
  liveCaptions.begin(owner, liveCaptionKey(environmentId, threadId, draftId));
  return {
    owner,
    [Symbol.dispose]() {
      liveCaptions.clear(owner);
      environment[Symbol.dispose]();
    },
    caption(patch: Partial<LiveCaption> = {}) {
      liveCaptions.caption(owner, {
        type: "live.caption",
        sessionId: "synthetic-session",
        role: "user",
        segmentId: "input",
        revision: 1,
        text: "Input partial",
        committed: false,
        ...patch,
      });
    },
  };
}

function viewport() {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column";
  return container;
}

it("keeps normal chat and both previews; only exact canonical IDs hide a revised caption", async () => {
  using live = session("canonical-identity");
  const props = {
    ...timelineProps("canonical-identity"),
    liveCaptionScope: { environmentId, threadId: "canonical-identity" },
  };
  const entries = [normalMessage("normal", "Existing chat")];
  await using screen = await render(<MessagesTimeline {...props} timelineEntries={entries} />, {
    container: viewport(),
  });
  await act(() => {
    live.caption();
    live.caption({ role: "assistant", segmentId: "output", text: "Output partial" });
  });
  await expect.element(screen.getByText("Existing chat", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Input partial", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Output partial", { exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll("[data-live-caption]")).toHaveLength(2);
  expect(screen.container.querySelector('[data-live-caption="user"]')?.textContent).toContain(
    "not final",
  );
  expect(screen.container.querySelector('[data-live-caption="assistant"]')?.textContent).toContain(
    "not final",
  );

  await act(() => {
    live.caption({
      revision: 3,
      text: "Corrected input",
      committed: true,
      messageId: MessageId.make("canonical_input"),
    });
    live.caption({ revision: 2, text: "Stale revision" });
    live.caption({ revision: 3, text: "Duplicate revision" });
  });
  expect(screen.container.querySelector('[data-live-caption="user"]')?.textContent).toContain(
    "Corrected input",
  );
  await expect.element(screen.getByText("Corrected input", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toMatch(
    /Input partial|Stale revision|Duplicate revision/,
  );
  await screen.rerender(
    <MessagesTimeline
      {...props}
      timelineEntries={[...entries, normalMessage("unrelated_input", "Corrected input")]}
    />,
  );
  expect(screen.container.querySelector('[data-live-caption="user"]')?.textContent).toContain(
    "Corrected input",
  );

  // Entry ID and text do not authorize dedupe; the canonical message ID does, even with different text.
  await screen.rerender(
    <MessagesTimeline
      {...props}
      timelineEntries={[...entries, normalMessage("canonical_input", "Canonical edited text")]}
    />,
  );
  expect(screen.container.querySelector('[data-live-caption="user"]')).toBeNull();
  await expect.element(screen.getByText("Canonical edited text", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Output partial", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Existing chat", { exact: true })).toBeVisible();
  expect(screen.container.querySelector("input, textarea, [contenteditable=true]")).toBeNull();
  // Rendering canonical history during Live must not destroy the retained preview in the store.
  expect(liveCaptions.getSnapshot().captions).toHaveLength(2);
});

it("retains mapped previews after Stop across draft binding; foreign history cannot consume them", async () => {
  using live = session(undefined, "draft-owner");
  const props = timelineProps("scope-retention");
  const draft = { environmentId, draftId: "draft-owner" };
  const thread = { environmentId, threadId: "bound-thread" };
  await using screen = await render(<MessagesTimeline {...props} liveCaptionScope={draft} />, {
    container: viewport(),
  });
  await act(() => {
    live.caption({
      text: "Retained preview",
      committed: true,
      messageId: MessageId.make("canonical_stop"),
    });
    live.caption({ role: "assistant", segmentId: "output", text: "Unmapped partial" });
    live.caption({
      segmentId: "unmapped-commit",
      text: "Committed without identity",
      committed: true,
    });
    live.caption({
      segmentId: "mapped-partial",
      text: "Mapped but uncommitted",
      messageId: MessageId.make("canonical_pending"),
    });
    liveCaptions.bind(live.owner, liveCaptionKey(environmentId, thread.threadId));
  });
  expect(
    screen.container.querySelector('[aria-label="Live voice captions"]')?.textContent,
  ).toContain("Retained preview");
  await expect.element(screen.getByText("Retained preview", { exact: true })).toBeVisible();
  await screen.rerender(<MessagesTimeline {...props} liveCaptionScope={thread} />);
  expect(
    screen.container.querySelector('[aria-label="Live voice captions"]')?.textContent,
  ).toContain("Retained preview");
  await expect.element(screen.getByText("Retained preview", { exact: true })).toBeVisible();
  await act(() => liveCaptions.finish(live.owner));
  expect(
    screen.container.querySelector('[aria-label="Live voice captions"]')?.textContent,
  ).toContain("Retained preview");
  await expect.element(screen.getByText("Retained preview", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toMatch(
    /Unmapped partial|Committed without identity|Mapped but uncommitted/,
  );
  await act(() => live.caption({ revision: 9, text: "Late event" }));
  expect(screen.container.textContent).not.toContain("Late event");

  // No canonical rows here: dedupe must not hide a broken scope check.
  await screen.rerender(
    <MessagesTimeline
      {...props}
      liveCaptionScope={{ ...thread, environmentId: "foreign-environment" }}
    />,
  );
  expect(screen.container.querySelector("[data-live-caption]")).toBeNull();
  await screen.rerender(
    <MessagesTimeline
      {...props}
      liveCaptionScope={{ ...thread, environmentId: "foreign-environment" }}
      timelineEntries={[normalMessage("canonical_stop", "Foreign history")]}
    />,
  );
  expect(screen.container.querySelector("[data-live-caption]")).toBeNull();
  await expect.element(screen.getByText("Foreign history", { exact: true })).toBeVisible();
  await screen.rerender(
    <MessagesTimeline
      {...props}
      liveCaptionScope={{ environmentId, threadId: "foreign-thread" }}
      timelineEntries={[normalMessage("canonical_stop", "Other thread history")]}
    />,
  );
  expect(screen.container.querySelector("[data-live-caption]")).toBeNull();
  await screen.rerender(<MessagesTimeline {...props} liveCaptionScope={draft} />);
  expect(
    screen.container.querySelector('[aria-label="Live voice captions"]')?.textContent,
  ).toContain("Retained preview");
  await expect.element(screen.getByText("Retained preview", { exact: true })).toBeVisible();
  await screen.rerender(
    <MessagesTimeline
      {...props}
      liveCaptionScope={thread}
      timelineEntries={[normalMessage("canonical_stop", "Canonical Stop history")]}
    />,
  );
  await expect.element(screen.getByText("Canonical Stop history", { exact: true })).toBeVisible();
  expect(screen.container.querySelector("[data-live-caption]")).toBeNull();
  expect(liveCaptions.getSnapshot().captions).toHaveLength(0);
});

it("shows truncation in the real timeline when preview capacity is exceeded", async () => {
  using live = session("overflow");
  await using screen = await render(
    <MessagesTimeline
      {...timelineProps("overflow")}
      liveCaptionScope={{ environmentId, threadId: "overflow" }}
    />,
    { container: viewport() },
  );
  await act(() => {
    for (let index = 0; index < 65; index++)
      live.caption({ segmentId: `segment-${index}`, text: `Preview ${index}` });
  });
  await expect
    .element(
      screen.getByText(
        "Earlier live previews are no longer shown. Captions are not final transcripts.",
        { exact: true },
      ),
    )
    .toBeVisible();
  expect(screen.container.querySelectorAll("[data-live-caption]")).toHaveLength(64);
  expect(screen.container.textContent).not.toContain("Preview 0");
  await expect.element(screen.getByText("Preview 64", { exact: true })).toBeVisible();
});
