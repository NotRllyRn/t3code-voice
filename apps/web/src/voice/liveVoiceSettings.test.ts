import { expect, it } from "vite-plus/test";
import { DEFAULT_LIVE_VOICE_PREFERENCES } from "@t3tools/contracts";
import { createJSONStorage } from "zustand/middleware";
import { createMemoryStorage } from "../lib/storage";
import { useLiveVoiceSettings } from "./liveVoiceSettings";

it("persists Live preferences separately and rejects stale unsupported preferences", async () => {
  const store = useLiveVoiceSettings;
  const initial = store.getState();
  const options = store.persist.getOptions();
  const name = options.name!;
  const storage = createMemoryStorage();
  store.persist.setOptions({ storage: createJSONStorage(() => storage) });
  try {
    expect(initial).toMatchObject(DEFAULT_LIVE_VOICE_PREFERENCES);
    store.setState({
      voice: "cove",
      notifications: "progress",
      microphoneId: "input",
      speakerId: "output",
    });
    const saved = storage.getItem(name);
    expect(typeof saved).toBe("string");
    store.setState({ ...DEFAULT_LIVE_VOICE_PREFERENCES, microphoneId: "", speakerId: "" });
    storage.setItem(name, saved as string);
    await store.persist.rehydrate();
    expect(store.getState()).toEqual({
      voice: "cove",
      notifications: "progress",
      microphoneId: "input",
      speakerId: "output",
    });
    storage.setItem(
      name,
      JSON.stringify({
        state: { voice: "invented", notifications: "all", microphoneId: 42, speed: 2 },
        version: 0,
      }),
    );
    await store.persist.rehydrate();
    expect(store.getState()).toEqual({
      ...DEFAULT_LIVE_VOICE_PREFERENCES,
      microphoneId: "",
      speakerId: "",
    });
  } finally {
    store.setState(initial, true);
    store.persist.setOptions(options);
  }
});
