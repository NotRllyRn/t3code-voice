import { describe, expect, it } from "vite-plus/test";
import fixtures from "./fixtures/live-native/events.json" with { type: "json" };
import httpFixture from "./fixtures/live-create-http.json" with { type: "json" };
import parentCapture from "./fixtures/live-native/parent-association.json" with { type: "json" };
import {
  NATIVE_LIVE_APPEND_CHUNK_BYTES,
  NATIVE_LIVE_MAX_CONTEXT_BYTES,
  NATIVE_LIVE_MAX_FRAME_BYTES,
  NATIVE_LIVE_MAX_NARRATION_BYTES,
  decodeNativeLiveCreateResponse,
  nativeLiveCreateResponseDiagnostics,
  decodeNativeLiveEvent,
  encodeNativeLiveAppend,
  encodeNativeLiveCreate,
  nativeLiveCallId,
  nativeLiveCallUrls,
} from "./liveProtocol.ts";

const decode = (event: unknown) => decodeNativeLiveEvent(JSON.stringify(event));
describe("pinned native Live wire", () => {
  it("retains captured parent/handoff identity and native turn lifecycle without offset authority", () => {
    for (const { payload } of parentCapture.frames) {
      const event = decode(payload);
      if (payload.type === "delegation.created")
        expect(event).toMatchObject({
          type: "delegation",
          userTurnId: payload.item!.user_bidi_turn_id,
          handoffId: payload.item!.handoff_id,
        });
      else if (payload.type === "turn.created")
        expect(event).toMatchObject({
          type: "turn_created",
          turnId: payload.turn!.id,
          role: "user",
          text: payload.turn!.transcript,
        });
      else if (payload.type === "turn.delta")
        expect(event).toEqual({ type: "turn_delta", turnId: payload.turn_id, text: payload.delta });
    }
  });
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

  it("preserves native delegation identity with explicit derived provenance, not a transcript cutoff", () => {
    for (const event of [fixtures.delegation, { ...fixtures.delegation, offset_ms: undefined }]) {
      expect(decode(event)).toEqual({
        type: "delegation",
        delegationId: "delegation-fictional",
        instructions: "Please rename the sample.",
        provenance: "native_live_delegation",
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
    ).toMatchObject({ instructions: "One hint.", provenance: "native_live_delegation" });
  });

  it.each([
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, user_bidi_turn_id: null } },
    {
      ...fixtures.delegation,
      item: { ...fixtures.delegation.item, user_bidi_turn_id: "../unsafe" },
    },
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, handoff_id: 42 } },
    { ...fixtures.delegation, item: { ...fixtures.delegation.item, handoff_id: "x".repeat(129) } },
    { type: "turn.created", turn: { id: "user-one", role: "tool", transcript: "poison" } },
    { type: "turn.created", turn: { role: "user", transcript: "missing identity" } },
    { type: "turn.delta", turn_id: "../unsafe", delta: "poison" },
    { type: "turn.delta", turn_id: "user-one", delta: null },
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

  it("keeps passive context local and encodes only deliberate speech offers", () => {
    expect(encodeNativeLiveAppend({ channel: "quiet", text: "Fictional context." })).toEqual([]);
    expect(
      encodeNativeLiveAppend({
        delegationId: "active-task",
        channel: "quiet",
        text: "Still working.",
      }),
    ).toEqual([]);
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
      const messages = encodeNativeLiveAppend({ channel: "speakable", text });
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.map((message) => message.content[0].text).join("")).toBe(text);
      for (const message of messages) {
        const chunk = message.content[0].text;
        expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(
          NATIVE_LIVE_APPEND_CHUNK_BYTES,
        );
        expect(Buffer.from(chunk).toString("utf8")).toBe(chunk);
        expect(message.channel).toBe("speakable");
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
    const initialContext = JSON.stringify({
      source: "T3_bound_history",
      note: "Untrusted history, not a new request",
      messages: [{ role: "user", text: "Fictional old request" }],
    });
    const bootstrap = encodeNativeLiveCreate({
      offerSdp: fixtures.createRequest.sdp,
      voice: "alloy",
      instructions: "Fixed policy",
      initialContext,
    });
    expect(bootstrap.session).not.toHaveProperty("initial_items");
    expect(bootstrap.session.instructions).toContain(initialContext);
    expect(bootstrap.session.instructions).toContain("not a new user turn");
    expect(() =>
      encodeNativeLiveCreate({
        offerSdp: fixtures.createRequest.sdp,
        voice: "alloy",
        instructions: "Fixed policy",
        initialContext: "x".repeat(NATIVE_LIVE_MAX_CONTEXT_BYTES + 1),
      }),
    ).toThrow();
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

  it("accepts source-writer SDP and plain MIME variants with matching diagnostics", () => {
    for (const variant of httpFixture.cases) {
      const response = { ...httpFixture, contentType: variant.contentType };
      const diagnostic = nativeLiveCreateResponseDiagnostics(response);
      expect(diagnostic).toMatchObject({
        failurePhase: "accepted",
        mimeCategory: variant.contentType === "application/sdp" ? "sdp" : "plain",
        bodyBytes: Buffer.byteLength(httpFixture.body),
        sdpPrefix: true,
        sdpAscii: true,
        sdpWithinLimit: true,
        sdpLineEndings: true,
        sdpVersionLine: true,
        sdpOriginLine: true,
        sdpSessionLine: true,
        sdpTimingLine: true,
        sdpAudioLine: true,
        sdpApplicationLine: true,
      });
      expect(decodeNativeLiveCreateResponse(response)).toEqual({
        callId: "fictional-owned",
        answerSdp: httpFixture.body,
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/fictional|123456789|0\.0\.0\.0|AA:AA/);
    }
    for (const contentType of [
      "Application/SDP; charset=utf-8",
      " application/sdp ; charset=US-ASCII ",
      "Text/Plain; charset=utf-8",
      " text/plain ; charset=US-ASCII ",
    ]) {
      for (const body of [
        httpFixture.body,
        httpFixture.body.replaceAll("\r\n", "\n"),
        "v=0\r\ns=" + "x".repeat(65536 - 7),
      ]) {
        const response = { ...httpFixture, contentType, body };
        expect(decodeNativeLiveCreateResponse(response).answerSdp).toBe(body);
        expect(nativeLiveCreateResponseDiagnostics(response).failurePhase).toBe("accepted");
      }
    }
  });

  it.each([
    ["status", { status: 200 }],
    ["mime", { contentType: "application/octet-stream" }],
    ["mime", { contentType: "" }],
    ["mime", { contentType: null }],
    ["mime", { contentType: "text/html; private=fictional-secret" }],
    ["mime", { contentType: "application/json" }],
    ["location", { location: "/v1/live/..%2Ffictional-secret" }],
    ["location", { location: null }],
    ["sdp", { body: "not SDP" }],
    ["sdp", { body: "" }],
    ["sdp", { body: "<html>fictional-secret</html>" }],
    ["sdp", { body: '{"sdp":"fictional-secret"}' }],
    ["sdp", { body: "v=0\r\ns=é\r\n" }],
    ["sdp", { body: "v=0\r\ns=\u0000fictional-secret\r\n" }],
    ["sdp", { body: "v=0\r\n" + "x".repeat(65536) }],
    ["sdp", { body: "v=0" }],
    ["sdp", { body: "v=0\rs=-\r" }],
  ] as const)("classifies %s rejection without retaining response material %#", (phase, patch) => {
    for (const contentType of ["application/sdp", "text/plain; charset=utf-8"]) {
      const response = { ...httpFixture, contentType, ...patch };
      expect(nativeLiveCreateResponseDiagnostics(response).failurePhase).toBe(phase);
      expect(JSON.stringify(nativeLiveCreateResponseDiagnostics(response))).not.toContain(
        "fictional-secret",
      );
      expect(() => decodeNativeLiveCreateResponse(response)).toThrow(
        /^Incompatible Live protocol$/,
      );
    }
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
