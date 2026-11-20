import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import baseConfig from "../vite.config.ts";

export default defineConfig({
  ...baseConfig,
  root: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  test: {
    ...baseConfig.test,
    projects: undefined,
    fileParallelism: false,
    include: [
      "scripts/voice-upstream-poll.test.ts",
      "scripts/voice-upstream-coordinator.test.ts",
      "scripts/voice-build-workflow.test.ts",
      "apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts",
    ],
  },
});
