import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { registerPrivilegesMock } = vi.hoisted(() => ({
  registerPrivilegesMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: vi.fn() },
  protocol: {
    handle: vi.fn(),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: registerPrivilegesMock,
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol Voice", () => {
  beforeEach(() => {
    registerPrivilegesMock.mockReset();
  });

  it("keeps both renderer and Clerk registration schemes separate from upstream", () => {
    assert.equal(ElectronProtocol.getDesktopScheme(false), "t3code-voice");
    assert.equal(ElectronProtocol.getDesktopScheme(true), "t3code-voice-dev");
    assert.equal(ElectronProtocol.getDesktopUrl(false), "t3code-voice://app/");
    assert.equal(ElectronProtocol.getDesktopUrl(true), "t3code-voice-dev://app/");
  });

  it.effect("registers privileges only for fork renderer protocols", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.provide(ElectronProtocol.layerSchemePrivileges));
      assert.equal(registerPrivilegesMock.mock.calls.length, 1);
      assert.deepEqual(
        registerPrivilegesMock.mock.calls[0]?.[0].map((entry: { scheme: string }) => entry.scheme),
        ["t3code-voice", "t3code-voice-dev"],
      );
    }),
  );
});
