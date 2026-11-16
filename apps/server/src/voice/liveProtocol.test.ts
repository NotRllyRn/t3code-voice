import { describe, expect, it } from "vite-plus/test";
import fixtures from "./fixtures/live-native/events.json" with { type: "json" };
import {
  NATIVE_LIVE_APPEND_CHUNK_BYTES,
  NATIVE_LIVE_MAX_CONTEXT_BYTES,
  NATIVE_LIVE_MAX_FRAME_BYTES,
  NATIVE_LIVE_MAX_NARRATION_BYTES,
  decodeNativeLiveCreateResponse,
  decodeNativeLiveEvent,
  encodeNativeLiveAppend,
  encodeNativeLiveCreate,
  nativeLiveCallId,
  nativeLiveCallUrls,
} from "./liveProtocol.ts";

const decode = (event: unknown) => decodeNativeLiveEvent(JSON.stringify(event));
describe("pinned native Live wire", () => {
  it("uses native transcript fields without inventing timing/finality or trusting updates as startup", () => {
    expect(decode(fixtures.started)).toEqual({ type: "started", sessionId: "session-fictional" });
    expect(decode(fixtures.updated)).toEqual({ type: "updated", sessionId: "session-fictional" });
    expect(decode(fixtures.input)).toEqual({
      type: "transcript",
      role: "user",
      itemId: "input-fictional",
      text: "Please rename the sample.",
    });
    expect(decode(fixtures.output)).toEqual({
      type: "transcript",
      role: "assistant",
      text: "I can help with that.",
    });
    expect(decode(fixtures.done)).toEqual({
      type: "turn_done",
      role: "user",
      turnId: "turn-fictional",
      text: "Please rename the sample.",
    });
    expect(
      decode({ type: "turn.done", turn: { role: "assistant", transcript: "A fictional answer." } }),
    ).toEqual({
      type: "turn_done",
      role: "assistant",
      text: "A fictional answer.",
    });
    expect(decode({ type: "output_audio.delta", audio: "AAE=" })).toBeNull();
    expect(decode({ type: "future.native.event" })).toBeNull();
    expect(decode({ type: "session.closed" })).toBeNull();
  });

  it("preserves delegation identity but blocks unsupported original-transcript association", () => {
    for (const event of [fixtures.delegation, { ...fixtures.delegation, offset_ms: undefined }]) {
      expect(decode(event)).toEqual({
        type: "delegation",
        delegationId: "delegation-fictional",
        transcriptHint: "Please rename the sample.",
        association: "unsupported-native-cutoff",
      });
    }
    expect(
      decode({
        ...fixtures.delegation,
        item: {
          ...fixtures.delegation.item,
          content: [
            { type: "input_text", text: "One " },
            { type: "input_text", text: "hint." },
          ],
        },
      }),
    ).toMatchObject({ transcriptHint: "One hint.", association: "unsupported-native-cutoff" });
  });

  it.each([
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, id: "../unsafe" } },
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, target: "server" } },
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, type: "function_call" } },
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, content: [] } },
    {
      ...fixtures.delegation,
      item: { ...fixtures.delegation.item, content: [{ type: "input_text" }] },
    },
    {
      ...fixtures.delegation,
      item: { ...fixtures.delegation.item, content: [{ type: "input_text", text: " " }] },
    },
    {
      ...fixtures.delegation,
      item: { ...fixtures.delegation.item, content: [{ type: "output_text", text: "poison" }] },
    },
    {
      ...fixtures.delegation,
      item: { ...fixtures.delegation.item, content: [{ type: "input_text", text: 42 }] },
    },
    {
      ...fixtures.delegation,
      item: {
        ...fixtures.delegation.item,
        content: Array.from({ length: 65 }, () => ({ type: "input_text", text: "a" })),
      },
    },
    { ...fixtures.delegation, offset_ms: -1 },
    { ...fixtures.delegation, offset_ms: "1000" },
    { ...fixtures.delegation, offset_ms: 1.5 },
    {
      type: "session.delegation.created",
      delegation: { id: "task-1", target: "client", offset_ms: 1000 },
    },
    { type: "session.input_transcript.delta", delta: "public, not native" },
    { type: "session.output_transcript.delta", delta: "public, not native" },
    { type: "turn.done", turn: { role: "tool", transcript: "poison" } },
    { type: "input_transcript.added", item: { text: "界".repeat(6_000) } },
    { type: "output_transcript.added", item: { text: "\ud800" } },
    { type: "session.started", session: { id: "" } },
    { type: "input_transcript.added", item: { text: null } },
    {},
    [],
    null,
  ])("fails closed on malformed/unknown dialect fields %#", (event) => {
    expect(() => decode(event)).toThrow(/^Incompatible Live protocol$/);
  });

  it("bounds frames and never forwards upstream error text", () => {
    expect(decode(fixtures.error)).toEqual({ type: "error", reason: "temporarily-unavailable" });
    for (const frame of [
      "x".repeat(NATIVE_LIVE_MAX_FRAME_BYTES + 1),
      JSON.stringify({ type: "error", message: "界".repeat(50_000) }),
      '{"fictional-poison-key":',
    ]) {
      expect(() => decodeNativeLiveEvent(frame)).toThrow(/^Incompatible Live protocol$/);
    }
  });

  it("encodes only native append names, IDs and explicit channels", () => {
    expect(encodeNativeLiveAppend({ channel: "quiet", text: "Fictional context." })).toEqual([
      fixtures.quietAppend,
    ]);
    expect(
      encodeNativeLiveAppend({
        delegationId: "delegation-fictional",
        channel: "speakable",
        text: "Fictional feedback.",
      }),
    ).toEqual([fixtures.taskAppend]);
    expect(() =>
      encodeNativeLiveAppend({ delegationId: "bad/id", channel: "quiet", text: "x" }),
    ).toThrow();
    expect(() => encodeNativeLiveAppend({ channel: "quiet", text: "\udc00" })).toThrow();
    expect(() => encodeNativeLiveAppend({ channel: "speakable", text: " " })).toThrow();
    expect(() =>
      encodeNativeLiveAppend({
        channel: "quiet",
        text: "x".repeat(NATIVE_LIVE_MAX_CONTEXT_BYTES + 1),
      }),
    ).toThrow();
    expect(() =>
      encodeNativeLiveAppend({
        channel: "speakable",
        text: "x".repeat(NATIVE_LIVE_MAX_NARRATION_BYTES + 1),
      }),
    ).toThrow();
  });

  it.each(["a".repeat(499) + "🎙️" + "界".repeat(400), "🎙️界é".repeat(300)])(
    "chunks ordered Unicode at native 500-byte boundaries without changing the text %#",
    (text) => {
      const messages = encodeNativeLiveAppend({ channel: "quiet", text });
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.map((message) => message.content[0].text).join("")).toBe(text);
      for (const message of messages) {
        const chunk = message.content[0].text;
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
          NATIVE_LIVE_APPEND_CHUNK_BYTES,
        );
        expect(Buffer.from(chunk).toString("utf8")).toBe(chunk);
        expect(message.channel).toBe("commentary");
      }
    },
  );

  it("freezes native JSON bootstrap and private call routes without a second session.start", () => {
    expect(
      encodeNativeLiveCreate({
        offerSdp: fixtures.createRequest.sdp,
        voice: "alloy",
        instructions: "Fictional session context.",
      }),
    ).toEqual(fixtures.createRequest);
    expect(decodeNativeLiveCreateResponse(fixtures.create)).toEqual({
      callId: "call-fictional",
      answerSdp: fixtures.create.body,
    });
    expect(nativeLiveCallUrls("https://relay.invalid/prefix/v1/live", "call-fictional")).toEqual(
      fixtures.routes,
    );
    expect(nativeLiveCallUrls("http://127.0.0.1:1234/v1/live", "call-fictional")).toEqual({
      sidebandUrl: "ws://127.0.0.1:1234/v1/live/call-fictional",
      hangupUrl: "http://127.0.0.1:1234/v1/realtime/calls/call-fictional/hangup",
    });
    for (const location of [
      "call-fictional",
      "/v1/realtime/calls/call-fictional",
      "https://untrusted.invalid/anything?call_id=call-fictional",
    ]) {
      expect(nativeLiveCallId(location)).toBe("call-fictional");
    }
    // A foreign Location supplies identity only; request destinations still use configured origin.
    expect(
      nativeLiveCallUrls(
        "https://relay.invalid/prefix/v1/live",
        nativeLiveCallId("https://foreign.invalid/v1/live/call-fictional"),
      ),
    ).toEqual(fixtures.routes);
  });

  it.each([
    { ...fixtures.create, status: 200 },
    { ...fixtures.create, status: 503 },
    { ...fixtures.create, contentType: "application/json" },
    { ...fixtures.create, location: null },
    { ...fixtures.create, location: "/v1/live/..%2Fpoison" },
    { ...fixtures.create, location: "javascript:poison?call_id=call-fictional" },
    { ...fixtures.create, location: "/v1/live/call-fictional?call_id=conflicting-id" },
    { ...fixtures.create, location: "/anything?call_id=call-fictional&call_id=other-id" },
    { ...fixtures.create, location: "https://user:poison@relay.invalid/v1/live/call-1" },
    { ...fixtures.create, location: "/v1/live/call-1\r\nAuthorization: poison" },
    { ...fixtures.create, body: "not SDP" },
  ])("rejects incompatible create responses without echoing private data %#", (response) => {
    expect(() => decodeNativeLiveCreateResponse(response)).toThrow(/^Incompatible Live protocol$/);
  });

  it.each([
    "http://remote.invalid/v1/live",
    "https://relay.invalid/v1/live?key=fictional",
    "https://user:fictional@relay.invalid/v1/live",
    "https://relay.invalid/v1/live#fragment",
    "https://relay.invalid/other/live",
    "https://relay.invalid/\r\nv1/live",
    "wss://relay.invalid/v1/live",
  ])("does not build private requests from an unsupported create URL %s", (url) => {
    expect(() => nativeLiveCallUrls(url, "call-fictional")).toThrow(/^Incompatible Live protocol$/);
  });
});
