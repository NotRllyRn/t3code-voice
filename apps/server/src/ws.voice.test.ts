import { expect, it } from "@effect/vitest";

import { hasCompatibleOrchestrationProtocol } from "./ws.ts";

it.each([
  ["orchestrationProtocol=2&clientCapabilities=voiceHistoryV1", false],
  ["orchestrationProtocol=3", false],
  ["orchestrationProtocol=3&clientCapabilities=notvoiceHistoryV1", false],
  ["orchestrationProtocol=3&clientCapabilities=voiceHistoryV1", true],
  ["orchestrationProtocol=3&clientCapabilities=settingsSecretReferences,voiceHistoryV1", true],
  ["orchestrationProtocol=4&clientCapabilities=voiceHistoryV1", false],
] as const)("gates Voice history before a socket upgrade: %s", (query, compatible) => {
  expect(hasCompatibleOrchestrationProtocol(new URL(`http://test.local/ws?${query}`))).toBe(
    compatible,
  );
});
