import { installFakeEnvironment, timelineProps } from "./testkit";
import type { OrchestrationV2VoiceMessage } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TooltipProvider } from "../../components/ui/tooltip";
import { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import "~/index.css";

function entries(delivery?: OrchestrationV2VoiceMessage["delivery"]) {
  const fixture = makeStreamingTimelineFixture();
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: fixture.visibleTurnItems.slice(2, 3).map((projected) => ({
      ...projected,
      item: {
        ...projected.item,
        ...(delivery
          ? {
              voice: {
                sessionId: "synthetic-session",
                itemId: "synthetic-item",
                sequence: 0,
                textKind: "generated_voice_reply" as const,
                delivery,
              },
            }
          : {}),
      },
    })),
    optimisticMessages: [],
  });
}

it("updates delivery notes on the retained assistant row and removes them without metadata", async () => {
  using _environment = installFakeEnvironment([], { providers: [] });
  const props = timelineProps("delivery-note");
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column";
  await using screen = await render(
    <TooltipProvider delay={0}>
      <MessagesTimeline {...props} timelineEntries={entries("drained")} />
    </TooltipProvider>,
    { container },
  );
  const drained = screen.getByText("Generated voice · audio drained", { exact: true });
  await expect.element(drained).toBeVisible();
  const row = screen.container.querySelector("[data-thread-find-text]");
  expect(row).not.toBeNull();
  expect(drained.element().className).toBe("mb-1 text-xs text-muted-foreground");
  await userEvent.hover(drained);
  await expect
    .element(
      page.getByText(
        "Full generated text, not an exact record of words heard or verified coding output.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await userEvent.unhover(drained);
  for (const delivery of ["interrupted", "unknown", "pending"] as const) {
    await screen.rerender(
      <TooltipProvider delay={0}>
        <MessagesTimeline {...props} timelineEntries={entries(delivery)} />
      </TooltipProvider>,
    );
    await expect
      .element(screen.getByText(`Generated voice · playback ${delivery}`, { exact: true }))
      .toBeVisible();
    expect(screen.container.querySelector("[data-thread-find-text]")).toBe(row);
    await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
  }
  await screen.rerender(
    <TooltipProvider delay={0}>
      <MessagesTimeline {...props} timelineEntries={entries()} />
    </TooltipProvider>,
  );
  expect(screen.container.textContent).not.toContain("Generated voice");
  expect(screen.container.querySelector("[data-thread-find-text]")).toBe(row);
  await expect.element(screen.getByText("Done", { exact: true })).toBeVisible();
});
