import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it.each(["t3code-voice", "t3code-voice-dev", "t3code-voice-preview"])(
    "unwraps %s QR links into the exact pairing host and code",
    (scheme) => {
      const pairingUrl = "https://remote.example.com/pair#token=pairing-token";
      const extracted = extractPairingUrlFromQrPayload(
        `  ${scheme}://pair?pairingUrl=${encodeURIComponent(` ${pairingUrl} `)}  `,
      );
      expect(extracted).toBe(pairingUrl);
      expect(parsePairingUrl(extracted)).toEqual({
        host: "https://remote.example.com",
        code: "pairing-token",
      });
    },
  );

  it.each(["t3code", "t3code-dev", "t3code-preview", "t3code-voice-other", "other"])(
    "does not unwrap an unrecognized %s scheme",
    (scheme) => {
      const payload = `${scheme}://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2F%23token%3Dpairing-token`;
      expect(extractPairingUrlFromQrPayload(` ${payload} `)).toBe(payload);
    },
  );

  it.each([
    "not a URL",
    "t3code-voice://[invalid?pairingUrl=https%3A%2F%2Fremote.example.com",
    "t3code-voice://pair",
    "t3code-voice://pair?pairingUrl=",
    "t3code-voice://pair?pairingUrl=%20%20",
    "t3code-voice://pair?pairingurl=https%3A%2F%2Fremote.example.com",
    "t3code-voice://pair#pairingUrl=https%3A%2F%2Fremote.example.com",
  ])("preserves malformed or missing-query payload %s", (payload) => {
    expect(extractPairingUrlFromQrPayload(payload)).toBe(payload);
  });

  it.each(["http", "https"])("preserves raw %s pairing QR input", (scheme) => {
    const payload = `${scheme}://remote.example.com:3773/pair#token=pairing-token`;
    expect(extractPairingUrlFromQrPayload(` ${payload} `)).toBe(payload);
    expect(parsePairingUrl(payload)).toEqual({
      host: `${scheme}://remote.example.com:3773`,
      code: "pairing-token",
    });
  });

  it("rejects an empty QR payload", () => {
    expect(() => extractPairingUrlFromQrPayload("  ")).toThrow(PairingQrPayloadEmptyError);
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
