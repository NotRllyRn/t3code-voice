import { describe, expect, it } from "vite-plus/test";

import type { NavigationState } from "@react-navigation/native";
import {
  findLinkedRoute,
  findStackRoute,
  MOBILE_APP_LINK_PREFIXES,
  restoreDraftLinkState,
  shouldHandleAppLink,
  updateLinkedRoute,
} from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each(MOBILE_APP_LINK_PREFIXES)("handles fork prefix %s without upstream claims", (prefix) => {
    expect(shouldHandleAppLink(prefix, true)).toBe(false);
    expect(shouldHandleAppLink(`${prefix}/?source=launch`, true)).toBe(false);
    expect(shouldHandleAppLink(`${prefix}pair?pairingUrl=x`, false)).toBe(true);
    expect(shouldHandleAppLink(`${prefix}threads/env-1/thread-1`, false)).toBe(true);
    expect(shouldHandleAppLink(`${prefix}expo-development-client/?url=x`, true)).toBe(false);
    expect(shouldHandleAppLink(`${prefix}expo-sharing/anything`, true)).toBe(false);
  });

  it.each([
    "t3code://threads/env-1/thread-1",
    "t3code-dev://pair?pairingUrl=x",
    "t3code-preview://settings/usage",
    "T3CODE://pair",
    "https://app.t3.codes/threads/env/thread",
  ])("rejects upstream URL %s", (url) => {
    expect(shouldHandleAppLink(url, true)).toBe(false);
    expect(shouldHandleAppLink(url, false)).toBe(false);
  });

  it("only filters the route, not text inside a prompt", () => {
    expect(
      shouldHandleAppLink(
        "t3code-voice://threads/env/thread?prompt=Fix%20expo-development-client%20and%20t3code://expo-sharing",
        true,
      ),
    ).toBe(true);
  });
});

describe("cloud-only deep links", () => {
  it.each([
    "t3code-voice://connect-onboarding",
    "t3code-voice-dev://connect-onboarding/?source=x",
    "t3code-voice://settings/waitlist",
    "t3code-voice://settings/auth",
    "exp://192.168.1.2:8081/--/settings/auth",
  ])("ignores %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(false);
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each([
    "t3code-voice://settings",
    "t3code-voice://settings/authors",
    "t3code-voice://pair?next=settings/auth",
    "t3code-voice://threads/env/thread/files/scripts/connect-onboarding",
    "t3code-voice://new/draft/files/settings/auth",
    "exp://192.168.1.2:8081/--/threads/env/thread/files/settings/waitlist",
  ])("still handles %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(true);
  });
});

describe("draft deep links", () => {
  it("opens the old draft URL on the thread screen with its draft identity", () => {
    const draft = { projectId: "project-1", environmentId: "env-1", draftId: "draft-1" };
    expect(
      restoreDraftLinkState(
        { routes: [{ name: "Home" }, { name: "Thread", params: draft }] },
        "/new/draft?draftId=draft-1",
      ),
    ).toEqual({
      index: 1,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft } }],
    });
  });

  it.each([
    ["environment", "NewTaskEnvironment"],
    ["branch", "NewTaskBranch"],
    ["files", "NewTaskFiles"],
    ["files/src/index.ts", "NewTaskFile"],
    ["attachments/attachment-1", "NewTaskAttachment"],
    ["settings", "NewTaskThreadSettings"],
  ])("restores a draft beneath its %s screen", (path, name) => {
    const params = { environmentId: "env-1", projectId: "project-1" };
    const target = { name, params };
    expect(
      restoreDraftLinkState({ routes: [{ name: "Home" }, target] }, `/new/draft/${path}`),
    ).toEqual({
      index: 2,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft: params } }, target],
    });
  });

  it("leaves live-thread and project-selection links unchanged", () => {
    const state = { routes: [{ name: "Thread", params: { threadId: "thread-1" } }] };
    expect(restoreDraftLinkState(state, "/threads/env-1/thread-1")).toBe(state);
    expect(restoreDraftLinkState(state, "/new")).toBe(state);
    expect(restoreDraftLinkState(undefined, "/new/draft")).toBeUndefined();
  });
});

describe("nested link routes", () => {
  const settingsLink = {
    routes: [
      { name: "Home" },
      {
        name: "SettingsSheet",
        state: {
          routes: [
            { name: "Settings" },
            { name: "SettingsEnvironmentNew", params: { pairingUrl: "x", autoConnect: "1" } },
          ],
        },
      },
    ],
  };

  it("finds a route the link opens inside a nested navigator", () => {
    expect(findLinkedRoute(settingsLink, ["SettingsEnvironmentNew"])?.params).toEqual({
      pairingUrl: "x",
      autoConnect: "1",
    });
    expect(findLinkedRoute(settingsLink, ["ConnectionsNew"])).toBeUndefined();
  });

  it("rewrites a nested route without touching the rest of the state", () => {
    const next = updateLinkedRoute(settingsLink, ["SettingsEnvironmentNew"], (route) => ({
      ...route,
      params: { pairingUrl: "x" },
    }));
    expect(findLinkedRoute(next, ["SettingsEnvironmentNew"])?.params).toEqual({ pairingUrl: "x" });
    expect(next?.routes[0]).toBe(settingsLink.routes[0]);
    expect(updateLinkedRoute(settingsLink, ["ConnectionsNew"], (route) => route)).toBe(
      settingsLink,
    );
  });
});

describe("findStackRoute", () => {
  const stack = (key: string, routes: NavigationState["routes"]) =>
    ({
      key,
      index: routes.length - 1,
      routeNames: routes.map((route) => route.name),
      routes,
      stale: false,
      type: "stack",
    }) as NavigationState;

  it("finds a nested screen with the navigator that holds it", () => {
    const root = stack("root", [
      { key: "home", name: "Home" },
      {
        key: "settings",
        name: "Settings",
        state: stack("settings-stack", [{ key: "new-task", name: "NewTaskProject" }]),
      },
    ]);
    expect(findStackRoute(root, "NewTaskProject")).toEqual({
      navigatorKey: "settings-stack",
      routeKey: "new-task",
      focused: true,
    });
  });

  it("reports whether the screen is its navigator's focused route", () => {
    const covered = stack("root", [
      { key: "new-task", name: "NewTaskProject" },
      { key: "add-project", name: "AddProject" },
    ]);
    expect(findStackRoute(covered, "NewTaskProject")?.focused).toBe(false);
    expect(findStackRoute(covered, "AddProject")?.focused).toBe(true);
  });

  it("prefers the top-most screen and reports a missing one", () => {
    const root = stack("root", [
      { key: "first", name: "NewTaskProject" },
      { key: "second", name: "NewTaskProject" },
    ]);
    expect(findStackRoute(root, "NewTaskProject")?.routeKey).toBe("second");
    expect(findStackRoute(root, "Thread")).toBeUndefined();
  });
});
