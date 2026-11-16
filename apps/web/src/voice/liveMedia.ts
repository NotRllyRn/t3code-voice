import type { LiveMediaFactory } from "@t3tools/client-runtime/voice-conversation";

/** RTP audio only; the server-side sideband remains authoritative for all app events. */
export const browserLiveMedia: LiveMediaFactory = async (options) => {
  let disposed = false;
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let playbackEnabled = false;
  let ready = false;
  const finalizers: Array<() => void> = [];
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.muted = true;
  audio.hidden = true;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener("abort", dispose);
    finalizers.splice(0).forEach((release) => release());
    stream?.getTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    audio.pause();
    if (audio.srcObject instanceof MediaStream)
      audio.srcObject.getTracks().forEach((track) => track.stop());
    audio.srcObject = null;
    audio.remove();
  };
  options.own(dispose);
  options.signal.addEventListener("abort", dispose, { once: true });
  const alive = () => !disposed && !options.signal.aborted && options.alive();
  const check = () => {
    if (!alive()) throw Error("Live media stopped");
  };
  const play = async () => {
    check();
    audio.muted = !playbackEnabled;
    if (playbackEnabled && audio.srcObject) await audio.play();
  };
  try {
    check();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    // A permission grant may arrive after Stop, navigation, or StrictMode teardown.
    if (!alive()) {
      stream.getTracks().forEach((track) => {
        track.enabled = false;
        track.stop();
      });
      throw Error("Live media stopped");
    }
    for (const track of stream.getTracks()) {
      track.enabled = false;
      const ended = () => {
        if (alive()) options.fail("media-denied");
      };
      track.addEventListener("ended", ended, { once: true });
      finalizers.push(() => track.removeEventListener("ended", ended));
    }
    peer = new RTCPeerConnection();
    const pc = peer;
    channel = pc.createDataChannel("oai-events");
    const dc = channel;
    const report = () => {
      if (!alive()) return;
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        options.peer("failed");
      } else if (!ready && pc.connectionState === "connected" && dc.readyState === "open") {
        ready = true;
        options.peer("connected");
      }
    };
    pc.onconnectionstatechange = report;
    dc.onopen = report;
    dc.onclose = () => {
      if (alive()) options.peer("failed");
    };
    dc.onerror = () => {
      if (alive()) options.peer("failed");
    };
    pc.ontrack = ({ track, streams }) => {
      if (!alive() || track.kind !== "audio") return;
      audio.srcObject = streams[0] ?? new MediaStream([track]);
      void play().catch(() => {
        if (alive()) options.fail("playback-blocked");
      });
    };
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    document.body.append(audio);
    return {
      async offer() {
        check();
        const offer = await pc.createOffer();
        check();
        await pc.setLocalDescription(offer);
        check();
        if (pc.iceGatheringState !== "complete") {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              cleanup();
              reject(Error("Live media stopped"));
            };
            const gathered = () => {
              if (pc.iceGatheringState === "complete") {
                cleanup();
                resolve();
              }
            };
            const cleanup = () => {
              pc.removeEventListener("icegatheringstatechange", gathered);
              options.signal.removeEventListener("abort", abort);
            };
            finalizers.push(abort);
            pc.addEventListener("icegatheringstatechange", gathered);
            options.signal.addEventListener("abort", abort, { once: true });
            if (!alive()) abort();
            else gathered();
          });
        }
        check();
        if (!pc.localDescription?.sdp) throw Error("Missing Live offer");
        return pc.localDescription.sdp;
      },
      async answer(sdp) {
        check();
        await pc.setRemoteDescription({ type: "answer", sdp });
        check();
      },
      microphone(enabled) {
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = alive() && ready && enabled;
        });
      },
      async playback(enabled) {
        playbackEnabled = enabled;
        await play();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
};
