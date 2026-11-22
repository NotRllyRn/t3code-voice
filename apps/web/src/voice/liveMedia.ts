import type { LiveMediaFactory } from "@t3tools/client-runtime/voice-conversation";

/** RTP audio only; the server-side sideband remains authoritative for all app events. */
export const browserLiveMedia: LiveMediaFactory = async (options) => {
  let disposed = false;
  let audioStopped = false;
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
  const stopAudio = () => {
    if (audioStopped) return;
    audioStopped = true;
    playbackEnabled = false;
    stream?.getTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
    audio.muted = true;
    audio.pause();
    audio.srcObject = null;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.signal.removeEventListener("abort", dispose);
    finalizers.splice(0).forEach((release) => release());
    stopAudio();
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
    audio.remove();
  };
  options.own(dispose);
  options.signal.addEventListener("abort", dispose, { once: true });
  const alive = () => !disposed && !audioStopped && !options.signal.aborted && options.alive();
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
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        ...(options.devices?.microphoneId
          ? { deviceId: { exact: options.devices.microphoneId } }
          : {}),
      },
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
    if (options.devices) {
      const capture = stream.getAudioTracks()[0]?.getSettings();
      const devices = await navigator.mediaDevices.enumerateDevices();
      check();
      const physical = (device: MediaDeviceInfo) =>
        device.deviceId !== "default" && device.deviceId !== "communications";
      const microphoneId =
        capture?.deviceId === "default" || capture?.deviceId === "communications"
          ? devices.find(
              (device) =>
                device.kind === "audioinput" &&
                physical(device) &&
                !!capture.groupId &&
                device.groupId === capture.groupId,
            )?.deviceId
          : capture?.deviceId;
      if (microphoneId) options.devices.microphoneId = microphoneId;
      if (!options.devices.speakerId && typeof audio.setSinkId === "function") {
        const defaultOutput = devices.find(
          (device) => device.kind === "audiooutput" && device.deviceId === "default",
        );
        options.devices.speakerId =
          devices.find(
            (device) =>
              device.kind === "audiooutput" &&
              physical(device) &&
              !!defaultOutput?.groupId &&
              device.groupId === defaultOutput.groupId,
          )?.deviceId ?? "";
      }
      if (options.devices.speakerId) {
        if (typeof audio.setSinkId !== "function") throw Error("Speaker selection is unavailable");
        await audio.setSinkId(options.devices.speakerId);
        check();
      }
    }
    peer = new RTCPeerConnection();
    const pc = peer;
    channel = pc.createDataChannel("oai-events");
    const dc = channel;
    const report = () => {
      if (disposed || options.signal.aborted) return;
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        dispose();
        options.peer("failed");
      } else if (
        alive() &&
        !ready &&
        pc.connectionState === "connected" &&
        dc.readyState === "open"
      ) {
        ready = true;
        options.peer("connected");
      }
    };
    pc.onconnectionstatechange = report;
    dc.onopen = report;
    dc.onclose = () => {
      if (!disposed) {
        dispose();
        options.peer("failed");
      }
    };
    dc.onerror = () => {
      if (!disposed) {
        dispose();
        options.peer("failed");
      }
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
      stopAudio,
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
};
