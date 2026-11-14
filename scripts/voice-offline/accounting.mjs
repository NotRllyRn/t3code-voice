// Numeric facts only: worklet counters are cumulative within a node/epoch, not deltas.
export function createPlaybackLedger() {
  const epochs = [],
    flushes = [];
  const check = (ok, message) => {
    if (!ok) throw Error(message);
  };
  const epoch = (node, id) => {
    let row = epochs.find((value) => value.node === node && value.epoch === id);
    if (!row) {
      check(epochs.length < 128, "Playback evidence limit");
      row = { node, epoch: id, enqueued: 0, progress: 0, consumed: 0 };
      epochs.push(row);
    }
    return row;
  };
  return {
    epochs,
    flushes,
    enqueue(node, id, samples, identity) {
      const row = epoch(node, id);
      check(
        !row.itemId ||
          (row.itemId === identity.item_id && row.contentIndex === identity.content_index),
        "Mixed playback identity",
      );
      row.itemId = identity.item_id;
      row.contentIndex = identity.content_index;
      row.enqueued += samples;
    },
    progress(node, id, played) {
      check(Number.isInteger(played) && played >= 0, "Invalid cumulative progress");
      const row = epoch(node, id);
      row.progress = Math.max(row.progress, played);
      row.consumed = Math.max(row.consumed, played);
    },
    flush(node, previousEpoch, event, latencySamples, contextSampleRate) {
      check(flushes.length < 128, "Flush evidence limit");
      flushes.push({
        node,
        previousEpoch,
        id: event.id,
        epoch: event.epoch,
        latencySamples,
        pcmSampleRate: 24000,
        contextSampleRate,
      });
    },
    flushed(node, event) {
      const fact = flushes.find(
        (value) => value.node === node && value.id === event.id && value.epoch === event.epoch,
      );
      check(fact && fact.played === undefined, "Unmatched flush acknowledgement");
      const row = epoch(node, fact.previousEpoch);
      check(
        Number.isInteger(event.played) &&
          event.played >= row.progress &&
          event.played <= row.enqueued,
        "Invalid flush consumption",
      );
      row.consumed = fact.played = event.played;
      Object.assign(fact, {
        itemId: row.itemId,
        contentIndex: row.contentIndex,
        enqueued: row.enqueued,
      });
    },
    snapshot() {
      return {
        epochs,
        flushes,
        progressSamples: epochs.reduce((n, row) => n + row.progress, 0),
        consumedSamples: epochs.reduce((n, row) => n + row.consumed, 0),
      };
    },
  };
}

export function assertTruncate(event, flush) {
  if (!flush || !Number.isInteger(flush.played))
    throw Error("Truncate without acknowledged interruption flush");
  if (event.item_id !== flush.itemId || event.content_index !== flush.contentIndex)
    throw Error("Truncate identity mismatch");
  if (flush.pcmSampleRate !== 24000) throw Error("Unexpected playback PCM rate");
  // The worklet consumes 24kHz protocol samples even on a different device sample rate.
  const endpoint = Math.floor(
    (Math.min(flush.enqueued, Math.max(0, flush.played - flush.latencySamples)) * 1000) /
      flush.pcmSampleRate,
  );
  if (event.audio_end_ms !== endpoint)
    throw Error(`Truncate endpoint mismatch: ${event.audio_end_ms} != ${endpoint}`);
}
