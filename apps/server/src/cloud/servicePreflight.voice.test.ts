import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it.each(["0.1.10-voice.1"])("blocks legacy launcher protocol with recovery for %s", (version) => {
  const launcherProtocol = 1;
  const result = runServicePreflight({
    databasePath: "/missing/state.sqlite",
    launcherProtocol,
    version,
  });

  expect(result).toMatchObject({ status: "blocked", version });
  const reason = result.status === "blocked" ? result.reason : "";
  expect(reason).toMatch(new RegExp(`\\b${launcherProtocol}\\b`));
  expect(reason).toMatch(new RegExp(`\\b${SERVICE_LAUNCHER_PROTOCOL}\\b`));
  expect(reason).toContain("https://github.com/NotRllyRn/t3code-voice/releases");
  expect(reason).toContain("manual");
  expect(reason).not.toMatch(/t3\.codes|install\.sh|npm install|npx|~\/\.local\/bin/);
  expect(reason).toContain("t3 --version");
  expect(reason).toContain("which -a t3");
});
