import type * as Context from "effect/Context";
import { vi } from "vite-plus/test";
import { ENVIRONMENT_ID, type FakeDriver } from "../../../test/fakeEnvironment";

// Reuse the existing wire fixture; everything above the connection driver stays real.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

export { installFakeEnvironment } from "../../../test/fakeEnvironment";
import { MessageId } from "@t3tools/contracts";
import { createRef, type ComponentProps } from "react";
import type { MessagesTimeline } from "../../components/chat/MessagesTimeline";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
export const environmentId = ENVIRONMENT_ID;

export function timelineProps(key: string): TimelineProps {
  return {
    timelineEntries: [],
    isWorking: false,
    listRef: createRef(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `${environmentId}:${key}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: environmentId,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

export function normalMessage(id: string, text: string): TimelineProps["timelineEntries"][number] {
  const fixture = makeStreamingTimelineFixture();
  const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: fixture.visibleTurnItems.slice(0, 1),
    optimisticMessages: [],
  });
  if (entry?.kind !== "message") throw new Error("Expected the fixture's user message");
  return {
    ...entry,
    id: `entry-${id}`,
    message: { ...entry.message, id: MessageId.make(id), text },
  };
}
