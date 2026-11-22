import { expect, it, vi } from "vite-plus/test";
import { browserLiveMedia } from "./liveMedia";
import { LiveVoiceController, type VoiceSocket } from "@t3tools/client-runtime/voice-conversation";
import type { LiveVoiceServerEvent } from "@t3tools/contracts";

class Track extends EventTarget {
  enabled = true;
  kind = "audio";
  stop = vi.fn();
}
class Peer extends EventTarget {
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  channel = {
    readyState: "connecting",
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: vi.fn(),
  };
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel);
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "v=0\r\ns=fictional\r\n" }));
  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  close = vi.fn();
}
function setup(grant?: Promise<MediaStream>) {
  const track = new Track();
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const peers: Peer[] = [];
  const rtc = vi.spyOn(window, "RTCPeerConnection").mockImplementation(function () {
    const peer = new Peer();
    peers.push(peer);
    return peer as unknown as RTCPeerConnection;
  });
  const microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockReturnValue(grant ?? Promise.resolve(stream));
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const abort = new AbortController();
  const owned: Array<() => void> = [];
  const peer = vi.fn();
  const fail = vi.fn();
  return {
    track,
    stream,
    peers,
    microphone,
    play,
    pause,
    abort,
    owned,
    peer,
    fail,
    options: {
      signal: abort.signal,
      alive: () => !abort.signal.aborted,
      own: (release: () => void) => {
        owned.push(release);
      },
      peer,
      fail,
    },
    [Symbol.dispose]() {
      abort.abort();
      owned.forEach((release) => release());
      rtc.mockRestore();
      microphone.mockRestore();
      play.mockRestore();
      pause.mockRestore();
    },
  };
}
it("captures disabled tracks, gates on PC and channel, and uses an actual audio element without PCM", async () => {
  using h = setup();
  const audioCount = document.querySelectorAll("audio").length;
  const media = await browserLiveMedia(h.options);
  expect(h.track.enabled).toBe(false);
  expect(document.querySelectorAll("audio").length).toBe(audioCount + 1);
  const audio = [...document.querySelectorAll("audio")].at(-1)!;
  expect(audio).toBeInstanceOf(HTMLAudioElement);
  expect(audio.muted).toBe(true);
  const peer = h.peers[0]!;
  expect(await media.offer()).toContain("v=0");
  await media.answer("v=0\r\ns=fictional-answer\r\n");
  expect(peer.setRemoteDescription).toHaveBeenCalledWith({
    type: "answer",
    sdp: "v=0\r\ns=fictional-answer\r\n",
  });
  media.microphone(true);
  expect(h.track.enabled).toBe(false);
  peer.connectionState = "connected";
  peer.onconnectionstatechange!();
  expect(h.peer).not.toHaveBeenCalled();
  peer.channel.readyState = "open";
  peer.channel.onopen!();
  expect(h.peer).toHaveBeenCalledWith("connected");
  media.microphone(true);
  expect(h.track.enabled).toBe(true);
  media.microphone(false);
  const remote = new MediaStream();
  peer.ontrack!({ track: { kind: "audio" } as MediaStreamTrack, streams: [remote] });
  expect(audio.srcObject).toBe(remote);
  await media.playback(true);
  expect(audio.muted).toBe(false);
  expect(h.play).toHaveBeenCalled();
  media.stopAudio();
  expect(h.track.enabled).toBe(false);
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  expect(peer.close).not.toHaveBeenCalled();
  expect(peer.channel.close).not.toHaveBeenCalled();
  expect(audio.muted).toBe(true);
  expect(audio.srcObject).toBeNull();
  media.microphone(true);
  expect(h.track.enabled).toBe(false);
  await expect(media.playback(true)).rejects.toThrow("Live media stopped");
  media.dispose();
  media.dispose();
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  expect(peer.close).toHaveBeenCalledTimes(1);
  expect(peer.channel.close).toHaveBeenCalledTimes(1);
  expect(peer.ontrack).toBeNull();
  expect(audio.srcObject).toBeNull();
  expect(document.querySelectorAll("audio").length).toBe(audioCount);
});
it("reports rejected autoplay visibly through safe reason, and data-channel closure releases readiness", async () => {
  using h = setup();
  const media = await browserLiveMedia(h.options);
  const peer = h.peers[0]!;
  await media.playback(true);
  h.play.mockRejectedValue(Error("sensitive-browser-detail"));
  peer.ontrack!({ track: { kind: "audio" } as MediaStreamTrack, streams: [new MediaStream()] });
  await vi.waitFor(() => expect(h.fail).toHaveBeenCalledWith("playback-blocked"));
  peer.channel.onclose!();
  expect(h.peer).toHaveBeenCalledWith("failed");
  media.dispose();
});
it("remote data-channel close during Stop preserves control until cleanup is acknowledged", async () => {
  using h = setup();
  const socket = Object.assign(new EventTarget(), {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  });
  const event = (value: LiveVoiceServerEvent) =>
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  const controller = new LiveVoiceController(
    {
      media: browserLiveMedia,
      socket: () => socket as unknown as VoiceSocket,
      url: async () => "wss://fixture.invalid/live",
    },
    () => {},
  );
  try {
    await controller.start();
    event({ type: "live.status", phase: "connecting", sessionId: "session", attemptId: "attempt" });
    await vi.waitFor(() =>
      expect(
        socket.send.mock.calls.some(([frame]) => JSON.parse(frame).type === "live.start"),
      ).toBe(true),
    );
    const peer = h.peers[0]!;
    event({
      type: "live.answer",
      sessionId: "session",
      attemptId: "attempt",
      answerSdp: "v=0\r\ns=fictional-answer\r\n",
    });
    peer.connectionState = "connected";
    peer.channel.readyState = "open";
    peer.channel.onopen!();
    event({ type: "live.status", phase: "connected", sessionId: "session", attemptId: "attempt" });
    await vi.waitFor(() => expect(h.track.enabled).toBe(true));
    controller.stop();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).not.toHaveBeenCalled();
    peer.channel.onclose!();
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(controller.state.phase).toBe("stopping");
    expect(controller.state.cleanupResult).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();
    await controller.start();
    expect(h.peers).toHaveLength(1);
    event({ type: "live.cleanup", sessionId: "session", result: "acknowledged" });
    expect(controller.state.phase).toBe("idle");
    expect(controller.state.cleanupResult).toBe("acknowledged");
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(h.track.enabled).toBe(false);
  } finally {
    controller.dispose();
    event({ type: "live.cleanup", sessionId: "session", result: "unknown" });
  }
});
it("stops a permission grant delivered after cancellation, without creating a peer", async () => {
  let grant!: (stream: MediaStream) => void;
  const pending = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  using h = setup(pending);
  const result = browserLiveMedia(h.options);
  h.abort.abort();
  grant(h.stream);
  await expect(result).rejects.toThrow("Live media stopped");
  expect(h.track.stop).toHaveBeenCalledTimes(1);
  expect(h.peers).toHaveLength(0);
});
it("does not apply a stale createOffer result to a disposed peer", async () => {
  using h = setup();
  const media = await browserLiveMedia(h.options);
  const peer = h.peers[0]!;
  let resolve!: (description: { type: "offer"; sdp: string }) => void;
  peer.createOffer.mockImplementationOnce(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }) as Promise<{ type: "offer"; sdp: string }>,
  );
  const result = media.offer();
  media.dispose();
  resolve({ type: "offer", sdp: "v=0\\r\\ns=stale\\r\\n" });
  await expect(result).rejects.toThrow("Live media stopped");
  expect(peer.setLocalDescription).not.toHaveBeenCalled();
});
it("dispose cancels pending ICE gathering and ignores stale track callbacks", async () => {
  using h = setup();
  const media = await browserLiveMedia(h.options);
  const peer = h.peers[0]!;
  const trackCallback = peer.ontrack!;
  peer.iceGatheringState = "gathering";
  const result = media.offer();
  await vi.waitFor(() => expect(peer.setLocalDescription).toHaveBeenCalled());
  media.dispose();
  await expect(result).rejects.toThrow("Live media stopped");
  trackCallback({ track: { kind: "audio" } as MediaStreamTrack, streams: [new MediaStream()] });
  expect(h.play).not.toHaveBeenCalled();
  expect(h.track.enabled).toBe(false);
});

it("ends the actual capture track immediately and keeps the peer open until disposal", async () => {
  using h = setup();
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamDestination();
    const track = source.stream.getAudioTracks()[0]!;
    h.microphone.mockResolvedValue(source.stream);
    const media = await browserLiveMedia(h.options);
    const peer = h.peers[0]!;
    peer.connectionState = "connected";
    peer.channel.readyState = "open";
    peer.channel.onopen!();
    media.microphone(true);
    expect(track.enabled).toBe(true);
    media.stopAudio();
    expect(track.readyState).toBe("ended");
    expect(track.enabled).toBe(false);
    expect(peer.close).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
    const audio = [...document.querySelectorAll("audio")].at(-1)!;
    peer.ontrack!({ track, streams: [source.stream] });
    media.microphone(true);
    expect(track.enabled).toBe(false);
    expect(audio.muted).toBe(true);
    expect(audio.srcObject).toBeNull();
    media.dispose();
    expect(peer.close).toHaveBeenCalledTimes(1);
  } finally {
    await context.close();
  }
});

it("pins microphone and speaker for recovery and keeps tracks off while selecting output", async () => {
  using h = setup();
  const settings = { deviceId: "microphone-original", groupId: "input-group" };
  Object.assign(h.track, { getSettings: () => settings });
  const output = (deviceId: string) =>
    ({
      kind: "audiooutput",
      deviceId,
      groupId: "output-group",
      label: "Speaker",
      toJSON: () => ({}),
    }) as MediaDeviceInfo;
  using _devices = vi
    .spyOn(navigator.mediaDevices, "enumerateDevices")
    .mockResolvedValue([output("default"), output("speaker-original")]);
  using sink = vi.spyOn(HTMLMediaElement.prototype, "setSinkId").mockImplementation(async () => {
    expect(h.track.enabled).toBe(false);
  });
  const devices = { microphoneId: "", speakerId: "" };
  const first = await browserLiveMedia({ ...h.options, devices });
  expect(devices).toEqual({ microphoneId: "microphone-original", speakerId: "speaker-original" });
  expect(sink).toHaveBeenLastCalledWith("speaker-original");
  first.dispose();
  const next = await browserLiveMedia({ ...h.options, devices });
  expect(h.microphone).toHaveBeenLastCalledWith({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      deviceId: { exact: "microphone-original" },
    },
    video: false,
  });
  expect(sink).toHaveBeenLastCalledWith("speaker-original");
  expect(h.track.enabled).toBe(false);
  next.dispose();
});
