// Web Locks cover windows on this origin; the server also enforces auth-session ownership.
export function acquireLiveVoiceLock(signal: AbortSignal): Promise<(() => Promise<void>) | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    if (!navigator.locks) {
      reject(Error("Web Locks are required for Live voice"));
      return;
    }
    let acquired = false;
    const request = navigator.locks.request(
      "t3code:live-voice",
      { ifAvailable: true },
      async (lock) => {
        if (!lock || signal.aborted) return;
        acquired = true;
        await new Promise<void>((release) =>
          resolve(() => {
            release();
            return request;
          }),
        );
      },
    );
    void request.then(() => {
      if (!acquired) resolve(null);
    }, reject);
  });
}
