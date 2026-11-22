import { expect, test, vi } from "vite-plus/test";
import {
  LIVE_VOICE_CONNECT_BUDGET_MS,
  LIVE_VOICE_CREATE_TIMEOUT_MS,
  LiveVoiceStartupError,
  LIVE_VOICE_STOP_TIMEOUT_MS,
  type LiveVoiceClientEvent,
  type LiveVoiceServerEvent,
} from "@t3tools/contracts";
import { LiveVoiceController } from "./liveController.ts";
import type { LiveMedia, LiveMediaOptions } from "./liveMedia.ts";
import type { VoiceSocket } from "./media.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Socket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent: LiveVoiceClientEvent[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  event(event: LiveVoiceServerEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}
function harness(
  acquire?: (media: LiveMedia, options: LiveMediaOptions) => Promise<LiveMedia>,
  ownership?: (signal: AbortSignal) => Promise<(() => void) | null>,
) {
  let socket = new Socket();
  const urls: string[] = [];
  const attempts: Array<{
    media: LiveMedia;
    options: LiveMediaOptions;
    offered: ReturnType<typeof deferred<void>>;
    enabled: boolean;
  }> = [];
  const event = vi.fn();
  const mediaFactory = vi.fn(async (options: LiveMediaOptions) => {
    const offered = deferred<void>();
    const item = {
      options,
      offered,
      enabled: false,
      media: {
        offer: vi.fn(async () => {
          offered.resolve();
          return "v=0\r\ns=fictional-offer\r\n";
        }),
        answer: vi.fn(async (_sdp: string) => {}),
        microphone: vi.fn((enabled: boolean) => {
          item.enabled = enabled;
        }),
        playback: vi.fn(async (_enabled: boolean) => {}),
        stopAudio: vi.fn(() => {
          item.enabled = false;
        }),
        dispose: vi.fn(() => {
          item.enabled = false;
        }),
      },
    };
    attempts.push(item);
    return acquire ? acquire(item.media, options) : item.media;
  });
  const publish = vi.fn();
  const controller = new LiveVoiceController(
    {
      socket: (url) => {
        urls.push(url);
        if (socket.readyState === 3) socket = new Socket();
        return socket as unknown as VoiceSocket;
      },
      url: async () => "wss://t3.example/api/voice/live?wsTicket=fictional",
      media: mediaFactory,
      ...(ownership ? { acquire: ownership } : {}),
      event,
    },
    publish,
  );
  return {
    publish,
    controller,
    get socket() {
      return socket;
    },
    urls,
    attempts,
    mediaFactory,
    event,
    authorize: (attemptId = "attempt_1") =>
      socket.event({ type: "live.status", sessionId: "session_1", phase: "connecting", attemptId }),
    answer: (attemptId = "attempt_1") =>
      socket.event({
        type: "live.answer",
        sessionId: "session_1",
        attemptId,
        answerSdp: "v=0\r\ns=fictional-answer\r\n",
      }),
    cleanup: (result: "acknowledged" | "failed" | "unknown" = "acknowledged") =>
      socket.event({ type: "live.cleanup", sessionId: "session_1", result }),
    connected: (attemptId = "attempt_1") =>
      socket.event({ type: "live.status", sessionId: "session_1", phase: "connected", attemptId }),
    [Symbol.dispose]: () => {
      controller.dispose();
      socket.event({ type: "live.cleanup", sessionId: "session_1", result: "acknowledged" });
    },
  };
}

async function offered(h: ReturnType<typeof harness>, attemptId = "attempt_1") {
  h.authorize(attemptId);
  await vi.waitFor(() =>
    expect(
      h.socket.sent.some((event) => event.type === "live.start" && event.attemptId === attemptId),
    ).toBe(true),
  );
}

test("requires server authorization, both peer and server readiness, then mutes hardware without touching coding", async () => {
  using h = harness();
  await h.controller.start();
  expect(h.mediaFactory).not.toHaveBeenCalled();
  await offered(h);
  const attempt = h.attempts[0]!;
  expect(attempt.enabled).toBe(false);
  h.answer();
  attempt.options.peer("connected");
  await Promise.resolve();
  expect(attempt.enabled).toBe(false);
  expect(attempt.media.playback).not.toHaveBeenCalled();
  expect(h.controller.state.phase).toBe("connecting");
  h.connected();
  await vi.waitFor(() => expect(attempt.enabled).toBe(true));
  h.controller.mute();
  expect(attempt.enabled).toBe(false);
  h.controller.mute();
  expect(attempt.enabled).toBe(true);
  h.controller.stop();
  expect(attempt.media.stopAudio).toHaveBeenCalledTimes(1);
  expect(attempt.media.dispose).not.toHaveBeenCalled();
  expect(h.socket.close).not.toHaveBeenCalled();
  expect(h.controller.state.phase).toBe("stopping");
  h.controller.stop();
  await h.controller.start();
  h.connected();
  h.authorize("attempt_2");
  attempt.options.peer("connected");
  h.controller.mute();
  expect(attempt.enabled).toBe(false);
  expect(h.mediaFactory).toHaveBeenCalledTimes(1);
  h.socket.event({ type: "live.closed", sessionId: "session_1" });
  h.socket.event({ type: "live.cleanup", sessionId: "foreign_session", result: "acknowledged" });
  expect(attempt.media.dispose).not.toHaveBeenCalled();
  h.cleanup();
  h.cleanup();
  expect(attempt.media.dispose).toHaveBeenCalledTimes(1);
  expect(h.socket.close).toHaveBeenCalledTimes(1);
  expect(h.controller.state.cleanupResult).toBe("acknowledged");
  expect(h.socket.sent.map((event) => event.type)).toEqual([
    "live.start",
    "live.peer",
    "live.mute",
    "live.mute",
    "live.stop",
  ]);
});

test("waits through 90s refresh without old ready deadline, then makes only the authorized fresh offer", async () => {
  vi.useFakeTimers();
  try {
    using h = harness();
    await h.controller.start();
    h.authorize();
    await vi.advanceTimersByTimeAsync(0);
    const first = h.attempts[0]!;
    h.socket.event({
      type: "live.status",
      sessionId: "session_1",
      phase: "refresh_wait",
      reason: "refresh-pending",
      retryAt: 90_000,
    });
    expect(first.media.dispose).toHaveBeenCalledTimes(1);
    expect(first.options.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.controller.state.phase).toBe("refresh_wait");
    expect(h.mediaFactory).toHaveBeenCalledTimes(1);
    h.authorize("attempt_2");
    await vi.advanceTimersByTimeAsync(0);
    h.answer("attempt_1");
    h.socket.event({
      type: "live.status",
      sessionId: "session_1",
      attemptId: "attempt_1",
      phase: "refresh_wait",
    });
    h.socket.event({
      type: "live.status",
      sessionId: "session_1",
      attemptId: "attempt_1",
      phase: "error",
      reason: "invalid-offer",
    });
    expect(h.controller.state.phase).toBe("connecting");
    expect(h.attempts[1]!.media.dispose).not.toHaveBeenCalled();
    expect(h.attempts[1]!.media.answer).not.toHaveBeenCalled();
    h.answer("attempt_2");
    h.attempts[1]!.options.peer("connected");
    h.connected("attempt_2");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts[1]!.enabled).toBe(true);
    h.authorize("attempt_2");
    expect(h.controller.state.phase).toBe("connected");
    expect(h.mediaFactory).toHaveBeenCalledTimes(2);
    h.controller.stop();
    h.cleanup();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.attempts[1]!.media.dispose).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["stop", "replacement"] as const)(
  "late grants after %s cannot overlap or enable media",
  async (action) => {
    const grant = deferred<LiveMedia>();
    using h = harness(async (media) => (h.attempts.length === 1 ? grant.promise : media));
    await h.controller.start();
    h.authorize();
    const first = h.attempts[0]!;
    if (action === "stop") h.controller.stop();
    else h.authorize("attempt_2");
    expect(h.mediaFactory).toHaveBeenCalledTimes(1);
    grant.resolve(first.media);
    await vi.waitFor(() => expect(first.media.dispose).toHaveBeenCalledTimes(1));
    expect(first.media.offer).not.toHaveBeenCalled();
    if (action === "stop") expect(h.socket.sent.map((event) => event.type)).toEqual(["live.stop"]);
    else {
      await offered(h, "attempt_2");
      expect(h.mediaFactory).toHaveBeenCalledTimes(2);
      expect(h.socket.sent.map((event) => event.type)).toEqual(["live.start"]);
    }
    first.options.peer("connected");
    expect(first.enabled).toBe(false);
  },
);

test("discards an in-flight first offer on refresh and a late answer from a foreign session", async () => {
  const offer = deferred<string>();
  using h = harness(async (media) => {
    if (h.attempts.length === 1) media.offer = () => offer.promise;
    return media;
  });
  await h.controller.start();
  h.authorize();
  await vi.waitFor(() => expect(h.attempts).toHaveLength(1));
  h.socket.event({ type: "live.status", sessionId: "session_1", phase: "refresh_wait" });
  await offered(h, "attempt_2");
  offer.resolve("v=0\r\ns=stale\r\n");
  h.socket.event({
    type: "live.answer",
    sessionId: "old_session",
    attemptId: "attempt_2",
    answerSdp: "v=0\r\ns=stale\r\n",
  });
  expect(h.attempts[1]!.media.answer).not.toHaveBeenCalled();
  expect(h.socket.sent.filter((event) => event.type === "live.start")).toHaveLength(1);
});

test("does not open the microphone while remote answer or playback is still pending", async () => {
  const answer = deferred<void>();
  const playback = deferred<void>();
  using h = harness(async (media) => {
    media.answer = () => answer.promise;
    media.playback = () => playback.promise;
    return media;
  });
  await h.controller.start();
  await offered(h);
  const attempt = h.attempts[0]!;
  h.answer();
  attempt.options.peer("connected");
  h.connected();
  h.controller.mute();
  h.controller.mute();
  expect(h.controller.state.phase).toBe("connecting");
  expect(attempt.enabled).toBe(false);
  answer.resolve();
  await Promise.resolve();
  expect(h.controller.state.phase).toBe("connecting");
  expect(attempt.enabled).toBe(false);
  playback.resolve();
  await vi.waitFor(() => expect(attempt.enabled).toBe(true));
  expect(h.controller.state.phase).toBe("connected");
});

test.each([
  ["answer", "resolve"],
  ["answer", "reject"],
  ["playback", "resolve"],
  ["playback", "reject"],
] as const)("ignores stale %s %s after Stop and a new generation", async (gate, outcome) => {
  const pending = deferred<void>();
  using h = harness(async (media) => {
    if (h.attempts.length === 1) {
      if (gate === "answer") media.answer = () => pending.promise;
      else media.playback = () => pending.promise;
    }
    return media;
  });
  await h.controller.start();
  await offered(h);
  const old = h.attempts[0]!;
  h.answer();
  old.options.peer("connected");
  h.connected();
  await Promise.resolve();
  expect(h.controller.state.phase).toBe("connecting");
  h.controller.stop();
  h.cleanup();
  expect(h.controller.state.phase).toBe("idle");
  expect(old.media.dispose).toHaveBeenCalledTimes(1);
  h.socket.readyState = 1;
  await h.controller.start();
  await offered(h, "new_attempt");
  const current = h.attempts[1]!;
  h.answer("new_attempt");
  current.options.peer("connected");
  h.connected("new_attempt");
  await vi.waitFor(() => expect(current.enabled).toBe(true));
  if (outcome === "resolve") pending.resolve();
  else pending.reject(Error("stale-private-error"));
  await Promise.resolve();
  await Promise.resolve();
  expect(old.media.microphone).not.toHaveBeenCalledWith(true);
  expect(old.media.dispose).toHaveBeenCalledTimes(1);
  expect(current.enabled).toBe(true);
  expect(current.media.dispose).not.toHaveBeenCalled();
  expect(h.controller.state.phase).toBe("connected");
  expect(h.controller.state.error).toBe("");
});

test.each(["playback-blocked", "invalid-offer", "media-denied", "forbidden"] as const)(
  "sanitizes %s and closes without a client retry",
  async (reason) => {
    using h = harness();
    await h.controller.start();
    await offered(h);
    const attempt = h.attempts[0]!;
    if (reason === "playback-blocked") {
      attempt.media.playback = async () => {
        throw Error("private-provider-payload");
      };
      h.answer();
      attempt.options.peer("connected");
      h.connected();
      await vi.waitFor(() => expect(h.controller.state.phase).toBe("stopping"));
    } else if (reason === "invalid-offer") {
      attempt.media.answer = async () => {
        throw Error("private-answer-error");
      };
      h.answer();
      await vi.waitFor(() => expect(h.controller.state.phase).toBe("stopping"));
    } else if (reason === "media-denied") attempt.options.fail(reason);
    else h.socket.event({ type: "live.status", sessionId: "session_1", phase: "error", reason });
    expect(attempt.media.stopAudio).toHaveBeenCalledTimes(1);
    h.cleanup();
    expect(h.controller.state.phase).toBe("error");
    expect(h.publish.mock.calls.some(([state]) => state.phase === "connected")).toBe(false);
    expect(h.controller.state.reason).toBe(reason);
    expect(h.controller.state.error).not.toContain("private-provider-payload");
    expect(attempt.media.dispose).toHaveBeenCalledTimes(1);
    expect(h.mediaFactory).toHaveBeenCalledTimes(1);
  },
);

test("caps authorization attempts and rejects unknown or binary app controls without a legacy speech classifier", async () => {
  using h = harness();
  await h.controller.start();
  h.socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({ type: "input_audio_buffer.speech_started" }),
    }),
  );
  expect(h.controller.state.reason).toBe("incompatible-protocol");
  expect(h.socket.sent.map((event) => event.type)).toEqual(["live.stop"]);
  expect(h.event).not.toHaveBeenCalled();
});

test("server connected status cannot bypass the total startup deadline while playback is blocked", async () => {
  vi.useFakeTimers();
  try {
    const playback = deferred<void>();
    using h = harness(async (media) => {
      media.playback = () => playback.promise;
      return media;
    });
    await h.controller.start();
    h.authorize();
    await vi.advanceTimersByTimeAsync(0);
    h.answer();
    h.attempts[0]!.options.peer("connected");
    h.connected();
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_CONNECT_BUDGET_MS);
    expect(h.controller.state.reason).toBe("timeout");
    playback.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attempts[0]!.enabled).toBe(false);
    expect(h.attempts[0]!.media.stopAudio).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_STOP_TIMEOUT_MS);
    expect(h.attempts[0]!.media.dispose).toHaveBeenCalledTimes(1);
    expect(h.controller.state.phase).toBe("reconnecting");
    h.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("microphone mute remains usable before control authentication finishes", async () => {
  const url = deferred<string>();
  const socket = new Socket();
  const controller = new LiveVoiceController(
    { media: vi.fn(), socket: () => socket as unknown as VoiceSocket, url: () => url.promise },
    () => {},
  );
  try {
    const start = controller.start();
    controller.mute();
    expect(controller.state.muted).toBe(true);
    expect(controller.state.phase).toBe("connecting");
    url.resolve("wss://t3.example/api/voice/live");
    await start;
    expect(socket.sent).toEqual([]);
    socket.event({ type: "live.status", phase: "connecting", sessionId: "session_1" });
    expect(socket.sent).toEqual([{ type: "live.mute", muted: true }]);
  } finally {
    controller.dispose();
  }
});

test("Stop cancels refresh immediately and the absolute startup budget bounds a silent server", async () => {
  vi.useFakeTimers();
  try {
    using h = harness();
    await h.controller.start();
    h.socket.event({ type: "live.status", sessionId: "session_1", phase: "refresh_wait" });
    h.controller.stop();
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_CONNECT_BUDGET_MS);
    expect(h.controller.state.phase).toBe("idle");
    expect(h.mediaFactory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    using silent = harness();
    await silent.controller.start();
    await vi.advanceTimersByTimeAsync(LIVE_VOICE_CONNECT_BUDGET_MS);
    expect(silent.controller.state.reason).toBe("timeout");
    expect(silent.controller.state.phase).toBe("reconnecting");
    silent.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  "acknowledged",
  "failed",
  "unknown",
  "deadline",
  "socket",
  "peer",
  "dispose",
  "answer-pending",
] as const)(
  "Stop finishes on %s without resuming capture or retaining ownership",
  async (outcome) => {
    vi.useFakeTimers();
    try {
      const pendingAnswer = deferred<void>();
      using h = harness(async (media) => {
        if (outcome === "answer-pending") media.answer = vi.fn(() => pendingAnswer.promise);
        return media;
      });
      await h.controller.start();
      h.authorize();
      await vi.advanceTimersByTimeAsync(0);
      h.answer();
      h.attempts[0]!.options.peer("connected");
      h.connected();
      await vi.advanceTimersByTimeAsync(0);
      const old = h.attempts[0]!;
      h.controller.stop();
      expect(old.enabled).toBe(false);
      expect(old.media.stopAudio).toHaveBeenCalledTimes(1);
      expect(old.media.dispose).not.toHaveBeenCalled();
      if (outcome === "socket") h.socket.close();
      else if (outcome === "peer") {
        old.options.peer("failed");
        expect(old.media.dispose).toHaveBeenCalledTimes(1);
        expect(h.socket.close).not.toHaveBeenCalled();
        h.cleanup();
      } else if (outcome === "deadline" || outcome === "dispose" || outcome === "answer-pending") {
        if (outcome === "dispose") h.controller.dispose();
        await vi.advanceTimersByTimeAsync(LIVE_VOICE_STOP_TIMEOUT_MS - 1);
        expect(old.media.dispose).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else h.cleanup(outcome);
      expect(old.media.dispose).toHaveBeenCalledTimes(1);
      expect(old.options.signal.aborted).toBe(true);
      expect(h.controller.state.phase).toBe("idle");
      expect(h.controller.state.cleanupResult).toBe(
        outcome === "peer"
          ? "acknowledged"
          : ["acknowledged", "failed"].includes(outcome)
            ? outcome
            : "unknown",
      );
      expect(h.socket.sent.filter((event) => event.type === "live.stop")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      if (outcome !== "dispose") {
        h.socket.readyState = 1;
        await h.controller.start();
        h.authorize("new_attempt");
        await vi.advanceTimersByTimeAsync(0);
        expect(h.mediaFactory).toHaveBeenCalledTimes(2);
        old.options.peer("connected");
        expect(old.enabled).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

test("Stop during create retains the peer past 12s, rejects Start, and bounds missing cleanup", async () => {
  vi.useFakeTimers();
  try {
    using h = harness();
    await h.controller.start();
    h.authorize();
    await vi.advanceTimersByTimeAsync(0);
    const old = h.attempts[0]!;
    h.controller.stop();
    expect(old.media.stopAudio).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(h.controller.state.phase).toBe("stopping");
    expect(old.media.dispose).not.toHaveBeenCalled();
    await h.controller.start();
    expect(h.mediaFactory).toHaveBeenCalledTimes(1);
    h.answer();
    h.connected();
    old.options.peer("connected");
    expect(old.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(
      LIVE_VOICE_CREATE_TIMEOUT_MS + LIVE_VOICE_STOP_TIMEOUT_MS - 13_001,
    );
    expect(old.media.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.media.dispose).toHaveBeenCalledTimes(1);
    expect(h.controller.state.cleanupResult).toBe("unknown");
    expect(h.controller.state.error).toContain("not acknowledged");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each(["forbidden", "environment-auth-required", "auth-required"] as const)(
  "safe %s startup failures do not acquire media or retry",
  async (reason) => {
    const media = vi.fn();
    const socket = vi.fn();
    const url = vi.fn(async () => {
      throw new LiveVoiceStartupError({ reason });
    });
    const controller = new LiveVoiceController({ media, socket, url }, () => {});
    await controller.start();
    expect(controller.state.reason).toBe(reason);
    expect(controller.state.phase).toBe("error");
    expect(controller.state.error).not.toContain("disconnected");
    expect(media).not.toHaveBeenCalled();
    expect(socket).not.toHaveBeenCalled();
    expect(url).toHaveBeenCalledTimes(1);
    controller.dispose();
  },
);

test("reconnects four times with cooldown then stops; Stop cancels cooldown", async () => {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const release = vi.fn();
  const acquire = vi.fn(async () => release);
  const controller = new LiveVoiceController(
    {
      acquire,
      url: async () => "wss://t3.example/live",
      socket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as VoiceSocket;
      },
      media: async () => {
        throw Error("unused");
      },
    },
    () => {},
  );
  try {
    await controller.start();
    for (const delay of [2000, 5000, 10000, 20000]) {
      const count = sockets.length;
      sockets.at(-1)!.close();
      expect(controller.state.phase).toBe("reconnecting");
      expect(controller.state.error).toBe("");
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(count + 1);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    }
    sockets.at(-1)!.close();
    expect(controller.state.phase).toBe("error");
    expect(release).toHaveBeenCalledTimes(1);
    await controller.start();
    sockets.at(-1)!.close();
    controller.stop();
    const count = sockets.length;
    await vi.advanceTimersByTimeAsync(200000);
    expect(sockets).toHaveLength(count);
    expect(controller.state.phase).toBe("idle");
    expect(release).toHaveBeenCalledTimes(2);
  } finally {
    controller.dispose();
    vi.useRealTimers();
  }
});

test("recovery preserves mute and pending run identity, drops acknowledged results and resets after success", async () => {
  vi.useFakeTimers();
  try {
    using h = harness();
    const connect = async () => {
      h.authorize();
      await vi.advanceTimersByTimeAsync(0);
      h.answer();
      h.attempts.at(-1)!.options.peer("connected");
      h.connected();
      await vi.advanceTimersByTimeAsync(0);
    };
    await h.controller.start();
    await connect();
    h.controller.mute();
    h.socket.event({
      type: "live.bound",
      threadId: "same-thread" as import("@t3tools/contracts").ThreadId,
    });
    h.socket.event({
      type: "live.agent",
      status: "started",
      runId: "same-run" as import("@t3tools/contracts").RunId,
    });
    const old = h.attempts[0]!;
    h.socket.close();
    expect(old.enabled).toBe(false);
    expect(old.media.dispose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    const retryUrl = new URL(h.urls.at(-1)!);
    expect(retryUrl.searchParams.get("threadId")).toBe("same-thread");
    expect(JSON.parse(retryUrl.searchParams.get("resumeRunIds")!)).toEqual(["same-run"]);
    await connect();
    expect(h.controller.state.phase).toBe("connected");
    expect(h.controller.state.muted).toBe(true);
    expect(h.attempts[1]!.enabled).toBe(false);
    expect(h.attempts[1]!.media.microphone).not.toHaveBeenCalledWith(true);
    expect(h.socket.sent).toContainEqual({ type: "live.mute", muted: true });
    h.socket.event({
      type: "live.agent",
      status: "completed",
      runId: "same-run" as import("@t3tools/contracts").RunId,
    });
    h.socket.close();
    expect(h.controller.state.recoveryAttempt).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(new URL(h.urls.at(-1)!).searchParams.has("resumeRunIds")).toBe(false);
    h.controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("unexpected cleanup recovers; pending task overflow stops explicitly without replay", async () => {
  vi.useFakeTimers();
  try {
    using h = harness();
    await h.controller.start();
    h.authorize();
    await vi.advanceTimersByTimeAsync(0);
    h.cleanup();
    expect(h.controller.state.phase).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2000);
    h.authorize();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 33; i++)
      h.socket.event({
        type: "live.agent",
        status: "started",
        runId: `run-${i}` as import("@t3tools/contracts").RunId,
      });
    h.cleanup();
    expect(h.controller.state.reason).toBe("recovery-limit");
    expect(h.controller.state.error).toContain("32 pending tasks");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("exclusive ownership rejects a second session and stays held until cleanup", async () => {
  let owned = false;
  const release = vi.fn(() => {
    owned = false;
  });
  const acquire = async () => {
    if (owned) return null;
    owned = true;
    return release;
  };
  using first = harness(undefined, acquire);
  using second = harness(undefined, acquire);
  await first.controller.start();
  await offered(first);
  await second.controller.start();
  expect(second.controller.state.phase).toBe("error");
  expect(second.controller.state.error).toContain("another window");
  expect(second.urls).toEqual([]);
  expect(second.mediaFactory).not.toHaveBeenCalled();
  first.controller.stop();
  await second.controller.start();
  expect(second.urls).toEqual([]);
  expect(release).not.toHaveBeenCalled();
  first.cleanup();
  expect(release).toHaveBeenCalledTimes(1);
  await second.controller.start();
  expect(second.urls).toHaveLength(1);
});

test.each(["stop", "dispose"] as const)(
  "%s during ownership acquisition releases a late lock without starting media",
  async (action) => {
    const claim = deferred<(() => void) | null>();
    const release = vi.fn();
    using h = harness(undefined, () => claim.promise);
    const starting = h.controller.start();
    const duplicate = h.controller.start();
    h.controller[action]();
    claim.resolve(release);
    await Promise.all([starting, duplicate]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.urls).toEqual([]);
    expect(h.mediaFactory).not.toHaveBeenCalled();
  },
);

test("keeps ownership until a cancelled microphone acquisition has released its late tracks", async () => {
  const grant = deferred<LiveMedia>();
  const released = deferred<void>();
  let owned = false;
  const release = vi.fn(() => {
    owned = false;
    released.resolve();
  });
  const acquire = async () => {
    if (owned) return null;
    owned = true;
    return release;
  };
  using first = harness(() => grant.promise, acquire);
  using second = harness(undefined, acquire);
  await first.controller.start();
  first.authorize();
  first.controller.stop();
  expect(release).not.toHaveBeenCalled();
  await second.controller.start();
  expect(second.urls).toEqual([]);
  grant.resolve(first.attempts[0]!.media);
  await released.promise;
  expect(first.attempts[0]!.media.dispose).toHaveBeenCalledTimes(1);
  expect(first.attempts[0]!.enabled).toBe(false);
  await second.controller.start();
  expect(second.urls).toHaveLength(1);
});
