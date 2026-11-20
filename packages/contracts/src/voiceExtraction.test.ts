import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2VoiceMessage as ExtractedVoiceMessage } from "./liveVoice.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2InternalCommand,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestrationV2VoiceMessage,
  ProviderCleanStartConstraint,
} from "./orchestrationV2.ts";

const decodeOrchestrationV2VoiceMessage = Schema.decodeUnknownSync(OrchestrationV2VoiceMessage);
const decodeOrchestrationV2ConversationMessageJson = Schema.decodeUnknownSync(
  OrchestrationV2ConversationMessageJson,
);
const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeOrchestrationV2InternalCommand = Schema.decodeUnknownSync(
  OrchestrationV2InternalCommand,
);
const decodeOrchestrationV2ThreadLaunchWorkspaceStrategy = Schema.decodeUnknownSync(
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
);
const decodeProviderCleanStartConstraint = Schema.decodeUnknownSync(ProviderCleanStartConstraint);

const voice = {
  sessionId: "session-1",
  itemId: "item-1",
  sequence: 0,
  textKind: "final_user_transcript",
  delivery: "unknown",
};
const completeVoice = {
  sessionId: "session-2",
  itemId: "item-2",
  sequence: 1,
  responseId: "response-1",
  contentIndex: 0,
  predecessorItemId: "item-1",
  textKind: "generated_voice_reply",
  transcriptFinality: "application_frozen",
  delivery: "interrupted",
  playedAudioMs: 120,
  sourceRunId: "run-1",
  sourceMessageIds: ["message-1", "message-2"],
};
const constraint = { instanceId: "pi_local", driver: "pi", environmentMode: "clean" };
const approvedBase = {
  branch: "release/approved",
  commit: "0123456789abcdef0123456789abcdef01234567",
};
const timestamp = "2026-11-20T00:00:00.000Z";
const message = {
  createdBy: "user",
  creationSource: "web",
  id: "message-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  role: "user",
  text: "Synthetic transcript",
  attachments: [],
  streaming: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const turnItem = {
  id: "turn-item-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: timestamp,
  type: "assistant_message",
  messageId: "message-1",
  text: "Synthetic reply",
  streaming: false,
};
const record = {
  type: "voice.message.record",
  commandId: "command-1",
  threadId: "thread-1",
  messageId: "message-1",
  role: "user",
  text: "Synthetic transcript",
  voice,
  createdBy: "user",
  creationSource: "web",
};
const launch = {
  commandId: "command-2",
  projectId: "project-1",
  title: "Synthetic launch",
  modelSelection: { instanceId: "pi_local", model: "test-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
};

// Literal wire fixtures are independent of the schemas' fields and enum constants.
function roundTrip<S extends Schema.Codec<unknown, unknown>>(schema: S, wire: unknown) {
  const decoded = Schema.decodeUnknownSync(schema)(wire);
  const encoded = Schema.encodeSync(schema)(decoded);
  expect(encoded).toStrictEqual(wire);
  expect(Object.keys(encoded as object)).toEqual(Object.keys(wire as object));
  expect(JSON.parse(JSON.stringify(encoded))).toStrictEqual(wire);
  return decoded;
}

describe("extracted Voice and retired clean-start contracts", () => {
  it("keeps the compatibility export and absent Voice optionals", () => {
    expect(OrchestrationV2VoiceMessage).toBe(ExtractedVoiceMessage);
    expect(roundTrip(OrchestrationV2VoiceMessage, voice)).toStrictEqual(voice);
    expect(roundTrip(OrchestrationV2VoiceMessage, completeVoice)).toStrictEqual(completeVoice);
    roundTrip(OrchestrationV2VoiceMessage, {
      ...completeVoice,
      transcriptFinality: "provider_final",
      delivery: "drained",
    });
  });

  it("preserves durable messages and event payloads with and without Voice", () => {
    for (const fixture of [message, { voice, ...message }, { voice: completeVoice, ...message }]) {
      roundTrip(OrchestrationV2ConversationMessageJson, fixture);
      roundTrip(OrchestrationV2DomainEventJson, {
        id: "event-1",
        threadId: "thread-1",
        occurredAt: timestamp,
        type: "message.updated",
        payload: fixture,
      });
    }
    const plain = decodeOrchestrationV2ConversationMessageJson(message);
    expect(Object.hasOwn(plain, "voice")).toBe(false);
  });

  it("preserves the turn-item Voice hook and absent optional fields", () => {
    roundTrip(OrchestrationV2TurnItemJson, turnItem);
    roundTrip(OrchestrationV2TurnItemJson, { voice: completeVoice, ...turnItem });
  });

  it("preserves server-only record commands and rejects them on public dispatch", () => {
    expect(roundTrip(OrchestrationV2InternalCommand, record)).toStrictEqual(record);
    roundTrip(OrchestrationV2InternalCommand, {
      ...record,
      voice: completeVoice,
      role: "assistant",
    });
    expect(() => decodeOrchestrationV2Command(record)).toThrow();
    for (const invalid of [
      { ...record, role: "system" },
      { ...record, text: " " },
      { ...record, createdBy: "provider" },
      { ...record, voice: { ...voice, sequence: -1 } },
      { ...record, voice: undefined },
    ]) {
      expect(() => decodeOrchestrationV2InternalCommand(invalid)).toThrow();
    }
  });

  it.each([
    { type: "root" },
    { type: "existing_worktree", worktreePath: "/tmp/fixture" },
    { type: "worktree", baseRef: "main" },
    {
      type: "root",
      cleanProviderConstraint: constraint,
      branch: "fixture",
      enforceNoSetupScripts: false,
    },
    {
      type: "existing_worktree",
      approvedBase,
      cleanProviderConstraint: constraint,
      worktreePath: "/tmp/fixture",
      branch: "fixture",
      enforceNoSetupScripts: true,
    },
    {
      type: "worktree",
      cleanProviderConstraint: constraint,
      baseRef: "main",
      approvedBase,
      branch: "fixture",
      startFromOrigin: false,
      enforceNoSetupScripts: true,
    },
  ])("preserves launch strategy %# including absent optionals", (workspaceStrategy) => {
    expect(
      roundTrip(OrchestrationV2ThreadLaunchWorkspaceStrategy, workspaceStrategy),
    ).toStrictEqual(workspaceStrategy);
    roundTrip(OrchestrationV2ThreadLaunchInput, { ...launch, workspaceStrategy });
  });

  it("retains exact retired constraint brands and literals", () => {
    expect(roundTrip(ProviderCleanStartConstraint, constraint)).toStrictEqual(constraint);
    for (const invalid of [
      { ...constraint, instanceId: "invalid/instance" },
      { ...constraint, driver: "codex" },
      { ...constraint, environmentMode: "normal" },
      { driver: "pi", environmentMode: "clean" },
    ]) {
      expect(() => decodeProviderCleanStartConstraint(invalid)).toThrow();
      expect(() =>
        decodeOrchestrationV2ThreadLaunchWorkspaceStrategy({
          type: "root",
          cleanProviderConstraint: invalid,
        }),
      ).toThrow();
    }
    for (const commit of ["abc", "G123456789abcdef0123456789abcdef01234567", "A".repeat(40)]) {
      for (const strategy of [
        { type: "existing_worktree", worktreePath: "/tmp/fixture" },
        { type: "worktree", baseRef: "main" },
      ]) {
        expect(() =>
          decodeOrchestrationV2ThreadLaunchWorkspaceStrategy({
            ...strategy,
            approvedBase: { ...approvedBase, commit },
          }),
        ).toThrow();
      }
    }
  });

  it.each([
    { sessionId: " " },
    { itemId: "" },
    { sequence: -1 },
    { sequence: 0.5 },
    { responseId: "" },
    { contentIndex: -1 },
    { predecessorItemId: " " },
    { textKind: "heard_audio" },
    { transcriptFinality: "verified" },
    { delivery: "played" },
    { playedAudioMs: -1 },
    { sourceRunId: "" },
    { sourceMessageIds: [""] },
  ])("rejects invalid Voice metadata %# at durable boundaries", (invalid) => {
    const badVoice = { ...voice, ...invalid };
    expect(() => decodeOrchestrationV2TurnItemJson({ ...turnItem, voice: badVoice })).toThrow();
    expect(() => decodeOrchestrationV2VoiceMessage(badVoice)).toThrow();
    expect(() =>
      decodeOrchestrationV2ConversationMessageJson({
        ...message,
        voice: badVoice,
      }),
    ).toThrow();
    expect(() => decodeOrchestrationV2InternalCommand({ ...record, voice: badVoice })).toThrow();
  });
});
