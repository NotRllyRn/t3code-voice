# Offline voice browser check

Runs the real development app/server against a loopback WebSocket mock, twice.
Each pass creates a fresh database, HOME, saved project/thread, and disposable
sandboxed Chromium context. No provider login, coding turn, build, or install.

## Run

Use a clean checkout with the existing repository dependencies and an existing
Playwright + Chromium installation. Use the repository's pinned Node version;
the driver also works with Node 24's native TypeScript loading. The browser host
must support sandboxed Chromium and loopback audio worklets. No microphone or
OS privacy permission is requested: an oscillator supplies the input stream.

```sh
# Local browser (omit VOICE_PLAYWRIGHT_PATH if require("playwright") resolves):
VOICE_PLAYWRIGHT_PATH=/path/to/existing/playwright node scripts/voice-offline/run.mjs

# Existing disposable browser host over SSH; no remote install or build:
VOICE_BROWSER_HOST=browser-test-host \
VOICE_BROWSER_NODE=/path/to/node \
VOICE_PLAYWRIGHT_PATH=/path/to/existing/playwright \
node scripts/voice-offline/run.mjs
```

`VOICE_PLAYWRIGHT_PATH` is a module name or absolute package directory **on the
browser host**. `VOICE_BROWSER_NODE` defaults to `node`. SSH mode uses a reverse
loopback tunnel; SSH must already work without interactive prompts. No host
configuration is changed. Each invocation has a four-minute overall deadline.

Output is a new directory under the OS temporary directory's
`t3voice-offline-evidence/`. Set `VOICE_OFFLINE_OUTPUT` to change this parent.
Each invocation retains `run.log` (including exception stacks and assertions)
and successful gates in `evidence.json`; earlier failure logs are not overwritten.
The driver masks app auth and user/temporary paths, not fictional fixture errors.
Source remains here after cleanup. On failure, use the printed log path.

## Gates and boundaries

- Exactly one advertised Codex model: the shipped `DEFAULT_MODEL`, explicitly
  registered through the supported `customModels` setting. Its binary path is
  deliberately nonexistent. Configuration atoms are mounted before reading;
  project/thread creation uses the existing app command APIs, not atom writes.
- Complete normal welcome/pairing, select the saved thread, and press the actual
  voice panel's Start button using accessible roles/names.
- The first allocation fails with a fictional mock error. Assert its finite
  allowlisted relay diagnostic and release of media/socket resources.
- Start again; capture and play two turns through the **native AudioWorklet**.
  Interrupt each after playback progresses, inject late audio after truncate,
  and prove it never reaches playback. Stop explicitly; assert idle, closed
  sockets/contexts/ports, and ended media tracks.
- Assert mock protocol counts, no tools or unexpected events, and finite stop
  diagnostics. Stop currently logs a non-upstream relay failure too; this check
  records that existing behavior without changing the application.

Only fictional credentials are generated. The app runs with an isolated HOME,
base directory, and stripped environment. Real `.env` files are refused. A
Node preload blocks non-loopback TCP egress in app/Vite processes, and browser
HTTP requests are restricted to loopback. SSH is transport to the test browser,
not provider access. This is an offline regression check, not a security sandbox.
There is no live mode. Do not pass provider keys or production state paths.

Normal completion, failure, and termination signals clean up child processes,
tunnels, remote runner files, temporary state, and synthetic audio. Evidence is
retained. SIGKILL/host loss cannot guarantee cleanup; inspect the named temporary
resources if that happens.

This does **not** validate a live provider, physical microphone/speakers,
subjective audio quality, native app permissions, or the unknown live-provider
interruption failure. Get an independent review before adapting it for live use.
