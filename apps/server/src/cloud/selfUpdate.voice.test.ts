import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ServerSelfUpdate from "./selfUpdate.ts";

it.effect("Voice runtimes reject upstream candidates but allow preview migration", () =>
  Effect.sync(() => {
    const refuse = ServerSelfUpdate.voiceServerUpdateRefusal;
    expect(refuse({ serverVersion: "0.1.9-voice.1", targetVersion: "1.0.0" })).toBe(
      "Voice servers can update only to Voice releases; refusing t3@1.0.0.",
    );
    expect(
      refuse({ serverVersion: "0.1.9-voice.1", targetVersion: "1.0.0-nightly.20261116.1" }),
    ).toBe(
      "Voice servers can update only to Voice releases; refusing t3@1.0.0-nightly.20261116.1.",
    );
    expect(
      refuse({
        serverVersion: "0.1.9-voice.1",
        targetVersion: "1.0.0-voice.1",
        channel: "stable",
      }),
    ).toBe(
      "Voice servers cannot switch to upstream release channels; update to a Voice release instead.",
    );
    expect(
      refuse({ serverVersion: "0.1.9-preview.20261116.1", targetVersion: "1.0.0-voice.1" }),
    ).toBeNull();
    expect(refuse({ serverVersion: "0.1.9-voice.1", targetVersion: "1.0.0-voice.2" })).toBeNull();
    for (const targetVersion of ["0.1.9-voice.1", "0.1.8-voice.9"]) {
      expect(refuse({ serverVersion: "0.1.9-voice.1", targetVersion })).toBe(
        "Voice updates require a newer release than 0.1.9-voice.1.",
      );
    }
    for (const targetVersion of ["0.1.9-voice.01", "v0.1.9-voice.2", "0.1.9-voice.2+build"]) {
      expect(refuse({ serverVersion: "0.1.9-voice.1", targetVersion })).toContain("only to Voice");
    }
  }),
);
