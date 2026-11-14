export const deadline = (promise, ms, message = "Operation timed out") => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Each start has one application identity/generation, independent of the upstream.
export class Lifecycle {
  constructor(onState = () => {}, closeMs = 5000) {
    this.onState = onState;
    this.closeMs = closeMs;
    this.generation = 0;
    this.state = "idle";
    this.current = null;
  }
  begin(profile, transport) {
    if (this.current) throw Error("Stop the current conversation first");
    const session = {
      generation: ++this.generation,
      identity: crypto.randomUUID(),
      profile,
      transport,
      controller: new AbortController(),
      finalizers: [],
      closed: false,
    };
    this.current = session;
    this.setState("starting");
    return session;
  }
  alive(session) {
    return this.current === session && !session.closed && session.generation === this.generation;
  }
  guard(session, fn) {
    return (...args) => {
      if (this.alive(session)) return fn(...args);
    };
  }
  own(session, fn) {
    if (!this.alive(session)) {
      Promise.resolve()
        .then(fn)
        .catch(() => {});
      return false;
    }
    session.finalizers.push(fn);
    return true;
  }
  setState(state, error = "") {
    this.state = state;
    this.onState(state, error);
  }
  active(session) {
    if (this.alive(session)) this.setState("active");
  }
  async stop(error = "") {
    const session = this.current;
    if (!session) return;
    if (session.stopping) return session.stopping;
    session.closed = true;
    ++this.generation;
    session.controller.abort();
    this.setState("stopping", error);
    // Independent tasks: failure/hang in one finalizer cannot skip another.
    session.stopping = deadline(
      Promise.allSettled(session.finalizers.map((fn) => Promise.resolve().then(fn))),
      this.closeMs,
    )
      .catch(() => {})
      .finally(() => {
        if (this.current === session) {
          this.current = null;
          this.setState(error ? "error" : "idle", error);
        }
      });
    return session.stopping;
  }
}
