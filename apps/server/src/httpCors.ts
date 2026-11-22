import { CLIENT_CAPABILITIES_HEADER, ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
  CLIENT_CAPABILITIES_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${FORK_DESKTOP.scheme}://app`,
  `${FORK_DESKTOP.developmentScheme}://app`,
] as const;

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";
