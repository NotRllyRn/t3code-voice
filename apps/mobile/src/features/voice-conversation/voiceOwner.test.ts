import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { voiceOwner } from "./voiceOwner";
import { ProviderInstanceId } from "@t3tools/contracts";

const thread = {
  environmentId: "env",
  id: "saved",
  providerInstanceId: "custom-codex",
  modelSelection: {
    instanceId: "custom-codex",
    model: "gpt-codex",
    options: [
      { id: "reasoningEffort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
} as unknown as EnvironmentThreadShell;
const input = {
  thread,
  effectiveModel: thread.modelSelection,
  driver: "codex",
  providerEnabled: true,
  ready: true,
};

describe("native voice saved owner gate", () => {
  it("uses the actual driver, not an instance name, and requires a saved connected operable thread", () => {
    expect(voiceOwner(input)?.thread).toBe(thread);
    expect(voiceOwner({ ...input, driver: "claude" })).toBeNull();
    expect(voiceOwner({ ...input, driver: undefined })).toBeNull();
    expect(voiceOwner({ ...input, providerEnabled: false })).toBeNull();
    expect(voiceOwner({ ...input, providerEnabled: undefined })).toBeNull();
    expect(voiceOwner({ ...input, thread: null })).toBeNull();
    expect(voiceOwner({ ...input, ready: false })).toBeNull();
    expect(voiceOwner({ ...input, thread: { ...thread, archivedAt: "2026-01-01" } })).toBeNull();
  });
  it("compares the full effective selection including options regardless of key order", () => {
    const effectiveModel = {
      ...thread.modelSelection,
      options: [
        { value: "priority", id: "serviceTier" },
        { id: "reasoningEffort", value: "high" },
      ],
    };
    expect(voiceOwner({ ...input, effectiveModel })?.key).toBe(voiceOwner(input)?.key);
    for (const effective of [
      { ...effectiveModel, model: "other" },
      { ...effectiveModel, instanceId: ProviderInstanceId.make("codex") },
      { ...effectiveModel, options: [{ id: "reasoningEffort", value: "low" }] },
    ])
      expect(voiceOwner({ ...input, effectiveModel: effective })).toBeNull();
  });
  it("changes identity on environment, thread, runtime, interaction, or canonical model changes", () => {
    const base = voiceOwner(input)?.key;
    for (const change of [
      { environmentId: "other" },
      { id: "other" },
      { runtimeMode: "auto" },
      { interactionMode: "plan" },
    ]) {
      expect(
        voiceOwner({ ...input, thread: { ...thread, ...change } as EnvironmentThreadShell })?.key,
      ).not.toBe(base);
    }
    const changed = { ...thread, modelSelection: { ...thread.modelSelection, model: "other" } };
    expect(
      voiceOwner({ ...input, thread: changed, effectiveModel: changed.modelSelection })?.key,
    ).not.toBe(base);
  });
});
