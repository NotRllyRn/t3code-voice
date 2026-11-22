import { installFakeEnvironment } from "./testkit";
import { DEFAULT_LIVE_VOICE_PREFERENCES, LIVE_VOICE_VOICES } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createJSONStorage } from "zustand/middleware";
import { act, render } from "../../../test/render";
import { LiveVoiceSettingsSection } from "../../components/settings/LiveVoiceSettingsSection";
import { useLiveVoiceSettings } from "../liveVoiceSettings";
import "~/index.css";

/** Own the descriptor so browser hardware is never consulted and cleanup restores it exactly. */
function replaceProperty(target: object, key: PropertyKey, value: unknown): Disposable {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    },
  };
}

const storageKey = "t3code:live-voice-settings:v1";

function setup({ speaker = true, microphoneId = "", speakerId = "" } = {}) {
  const cleanup = new DisposableStack();
  cleanup.use(installFakeEnvironment([], { providers: [] }));
  const store = useLiveVoiceSettings;
  const previous = store.getState();
  const options = store.persist.getOptions();
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
  };
  store.persist.setOptions({ storage: createJSONStorage(() => storage) });
  store.setState({ ...DEFAULT_LIVE_VOICE_PREFERENCES, microphoneId, speakerId }, true);
  cleanup.defer(() => {
    store.setState(previous, true);
    store.persist.setOptions(options);
  });
  const devices = new EventTarget();
  const enumerateDevices = vi.fn(async (): Promise<MediaDeviceInfo[]> => [
    device("audioinput", "mic-1", "Desk microphone"),
    device("audiooutput", "speaker-1", "Desk speaker"),
    device("audioinput", "default", "Default duplicate"),
    device("audioinput", "communications", "Communications duplicate"),
    device("audiooutput", "default", "Default speaker duplicate"),
    device("audiooutput", "communications", "Communications speaker duplicate"),
  ]);
  const getUserMedia = vi.fn(() => {
    throw new Error("Settings must not acquire real media");
  });
  cleanup.use(
    replaceProperty(
      navigator,
      "mediaDevices",
      Object.assign(devices, { enumerateDevices, getUserMedia }),
    ),
  );
  const sink = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");
  if (speaker) cleanup.use(replaceProperty(HTMLMediaElement.prototype, "setSinkId", vi.fn()));
  else {
    Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    cleanup.defer(() => {
      if (sink) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", sink);
    });
  }
  return {
    [Symbol.dispose]: () => cleanup.dispose(),
    saved,
    store,
    enumerateDevices,
    getUserMedia,
    devices,
    read: () => JSON.parse(saved.get(storageKey)!).state,
  };
}

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "synthetic", toJSON: () => ({ kind, deviceId, label }) };
}

it("offers nine contract voices and persists voice/progress choices separately from dictation", async () => {
  using fixture = setup();
  using browserStorageWrites = vi.spyOn(Storage.prototype, "setItem");
  await using screen = await render(<LiveVoiceSettingsSection />);
  await expect
    .element(screen.getByRole("combobox", { name: "Live voice", exact: true }))
    .toHaveTextContent(DEFAULT_LIVE_VOICE_PREFERENCES.voice);
  await expect
    .element(screen.getByRole("switch", { name: "Live voice progress updates" }))
    .not.toBeChecked();
  await userEvent.click(screen.getByRole("combobox", { name: "Live voice", exact: true }));
  await expect.element(page.getByRole("listbox")).toBeVisible();
  const options = page
    .getByRole("option")
    .elements()
    .map((option) => option.textContent?.trim());
  expect(options).toHaveLength(9);
  expect(options).toEqual([...LIVE_VOICE_VOICES]);
  await userEvent.click(page.getByRole("option", { name: "cove", exact: true }));
  await expect
    .element(screen.getByRole("combobox", { name: "Live voice", exact: true }))
    .toHaveTextContent("cove");
  await userEvent.click(screen.getByRole("switch", { name: "Live voice progress updates" }));
  expect(fixture.read().notifications).toBe("progress");
  await expect
    .element(screen.getByRole("switch", { name: "Live voice progress updates" }))
    .toBeChecked();
  expect(fixture.read()).toMatchObject({ voice: "cove", notifications: "progress" });
  const persisted = fixture.saved.get(storageKey)!;
  await act(async () => {
    fixture.store.setState(
      { ...DEFAULT_LIVE_VOICE_PREFERENCES, microphoneId: "", speakerId: "" },
      true,
    );
    fixture.saved.set(storageKey, persisted);
    await fixture.store.persist.rehydrate();
  });
  await expect
    .element(screen.getByRole("combobox", { name: "Live voice", exact: true }))
    .toHaveTextContent("cove");
  await expect
    .element(screen.getByRole("switch", { name: "Live voice progress updates" }))
    .toBeChecked();
  await userEvent.click(screen.getByRole("switch", { name: "Live voice progress updates" }));
  expect(fixture.read().notifications).toBe("terminal");
  expect(
    browserStorageWrites.mock.calls
      .map(([key]) => key)
      .filter((key) => /settings|speech|dictation|voice/i.test(key)),
  ).toEqual([]);
  expect([...fixture.saved.keys()]).toEqual([storageKey]);
  expect(fixture.getUserMedia).not.toHaveBeenCalled();
});

it("rejects unsupported saved voices and progress modes in the actual settings UI", async () => {
  using fixture = setup();
  fixture.store.setState({
    voice: "cove",
    notifications: "progress",
    microphoneId: "mic-sentinel",
  });
  fixture.saved.set(
    storageKey,
    JSON.stringify({
      state: { voice: "invented", notifications: "all", microphoneId: 42 },
      version: 0,
    }),
  );
  await fixture.store.persist.rehydrate();
  expect(fixture.store.getState()).toMatchObject({
    voice: "maple",
    notifications: "terminal",
    microphoneId: "",
  });
  await using screen = await render(<LiveVoiceSettingsSection />);
  await expect
    .element(screen.getByRole("combobox", { name: "Live voice", exact: true }))
    .toHaveTextContent(DEFAULT_LIVE_VOICE_PREFERENCES.voice);
  await expect
    .element(screen.getByRole("switch", { name: "Live voice progress updates" }))
    .not.toBeChecked();
  await expect
    .element(screen.getByRole("combobox", { name: "Live microphone", exact: true }))
    .toHaveTextContent("System default");
  expect(fixture.getUserMedia).not.toHaveBeenCalled();
});

it("refreshes devices by button and devicechange without losing saved selections; default persists empty IDs", async () => {
  using fixture = setup({ microphoneId: "missing-mic", speakerId: "missing-speaker" });
  await using screen = await render(<LiveVoiceSettingsSection />);
  await vi.waitFor(() => expect(fixture.enumerateDevices).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("combobox", { name: "Live microphone", exact: true }));
  await expect
    .element(page.getByRole("option", { name: "Saved device (unavailable)", exact: true }))
    .toBeVisible();
  expect(
    page
      .getByRole("option")
      .elements()
      .map((option) => option.textContent?.trim()),
  ).toEqual(["System default", "Desk microphone", "Saved device (unavailable)"]);
  await userEvent.click(page.getByRole("option", { name: "Desk microphone", exact: true }));
  await userEvent.click(screen.getByRole("combobox", { name: "Live speaker", exact: true }));
  expect(
    page
      .getByRole("option")
      .elements()
      .map((option) => option.textContent?.trim()),
  ).toEqual(["System default", "Desk speaker", "Saved device (unavailable)"]);
  await userEvent.click(page.getByRole("option", { name: "Desk speaker", exact: true }));
  expect(fixture.read()).toMatchObject({ microphoneId: "mic-1", speakerId: "speaker-1" });

  fixture.enumerateDevices.mockResolvedValue([
    device("audioinput", "mic-2", "Replacement microphone"),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await vi.waitFor(() => expect(fixture.enumerateDevices).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("combobox", { name: "Live microphone", exact: true }));
  await expect
    .element(page.getByRole("option", { name: "Replacement microphone", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "Saved device (unavailable)", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(fixture.read()).toMatchObject({ microphoneId: "mic-1", speakerId: "speaker-1" });

  fixture.enumerateDevices.mockResolvedValue([
    device("audioinput", "mic-1", "Returned microphone"),
    device("audiooutput", "speaker-1", "Returned speaker"),
  ]);
  await act(() => fixture.devices.dispatchEvent(new Event("devicechange")));
  await vi.waitFor(() => expect(fixture.enumerateDevices).toHaveBeenCalledTimes(3));
  await expect
    .element(screen.getByRole("combobox", { name: "Live microphone", exact: true }))
    .toHaveTextContent("Returned microphone");
  await expect
    .element(screen.getByRole("combobox", { name: "Live speaker", exact: true }))
    .toHaveTextContent("Returned speaker");
  for (const label of ["Live microphone", "Live speaker"]) {
    await userEvent.click(screen.getByRole("combobox", { name: label, exact: true }));
    await userEvent.click(page.getByRole("option", { name: "System default", exact: true }));
    expect(fixture.read()[label === "Live microphone" ? "microphoneId" : "speakerId"]).toBe("");
    await expect
      .element(screen.getByRole("combobox", { name: label, exact: true }))
      .toHaveTextContent("System default");
  }
  expect(fixture.read()).toMatchObject({ microphoneId: "", speakerId: "" });
  expect([...fixture.saved.keys()]).toEqual([storageKey]);
  expect(fixture.getUserMedia).not.toHaveBeenCalled();
});

it("clears device names on enumeration failure and hides unsupported speaker selection", async () => {
  using fixture = setup({ speaker: false });
  await using screen = await render(<LiveVoiceSettingsSection />);
  await vi.waitFor(() => expect(fixture.enumerateDevices).toHaveBeenCalledTimes(1));
  expect(screen.container.querySelector('[aria-label="Live speaker"]')).toBeNull();
  // First prove a successful list, so a stale list after rejection cannot pass.
  await userEvent.click(screen.getByRole("combobox", { name: "Live microphone", exact: true }));
  await expect
    .element(page.getByRole("option", { name: "Desk microphone", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  fixture.enumerateDevices.mockRejectedValue(new Error("Synthetic device failure"));
  await userEvent.click(screen.getByRole("button", { name: "Refresh devices" }));
  await vi.waitFor(() => expect(fixture.enumerateDevices).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole("combobox", { name: "Live microphone", exact: true }));
  await expect
    .element(page.getByRole("option", { name: "System default", exact: true }))
    .toBeVisible();
  expect(
    page
      .getByRole("option")
      .elements()
      .map((option) => option.textContent?.trim()),
  ).toEqual(["System default"]);
  await userEvent.keyboard("{Escape}");
  expect(fixture.getUserMedia).not.toHaveBeenCalled();
});
