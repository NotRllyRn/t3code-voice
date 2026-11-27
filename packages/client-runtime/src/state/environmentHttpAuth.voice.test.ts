import { describe, expect, it } from "@effect/vitest";
import {
  CLIENT_CAPABILITIES_HEADER,
  EnvironmentId,
  VOICE_HISTORY_CAPABILITY,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import { getEnvironmentLiveVoiceUrl } from "../voice-conversation/environmentUrl.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "./boundedThreadSnapshotHttp.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";

const encodeBoundedSnapshot = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);
const encodeThreadTranscript = Schema.encodeSync(OrchestrationV2ThreadTranscript);

const TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://previous.example.test",
  socketUrl: "wss://previous.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 },
  target: TARGET,
};
const CURRENT_ORIGIN = "https://current.example.test";
const RENEWED_ORIGIN = "https://renewed.example.test";
const SHELL = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  threads: [],
  archivedThreads: [],
} satisfies OrchestrationV2ShellSnapshot;
const THREAD = {
  snapshotSequence: 2,
  projection: v2Projection,
} satisfies OrchestrationV2ThreadDetailSnapshot;
const TRANSCRIPT = {
  threadId: v2Projection.thread.id,
  title: v2Projection.thread.title,
  updatedAt: v2Projection.updatedAt,
  items: v2Projection.visibleTurnItems,
} satisfies OrchestrationV2ThreadTranscript;
const BOUNDED_THREAD = {
  ...THREAD,
  historyCursor: "older-page",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 3,
} satisfies OrchestrationV2ThreadBoundedSnapshot;
const THREAD_HISTORY = {
  snapshotSequence: 2,
  items: [],
  nextCursor: null,
  hasMoreHistory: false,
} satisfies OrchestrationV2ThreadHistoryPage;

function credentialRejectedResponse(reason = "invalid_credential") {
  return Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason,
      traceId: "trace-rejected",
    },
    { status: 401 },
  );
}

function makeHarness(reply: (requestNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const proofs: Array<ManagedRelay.ManagedRelayDpopProofInput> = [];
  const remoteAuthorization = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("Unexpected bearer connection preparation."),
    authorizeDpop: () => Effect.die("HTTP requests must not prepare a WebSocket connection."),
    authorizeDirectDpop: () => Effect.die("HTTP requests must not prepare a WebSocket connection."),
    authorizeDirectDpopHttp: () => Effect.die("Unexpected direct DPoP authorization."),
    authorizeDpopHttp: (input) =>
      Effect.sync(() => {
        const rejected = input.rejectedAccessToken !== undefined;
        return {
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          httpBaseUrl: rejected ? RENEWED_ORIGIN : CURRENT_ORIGIN,
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: rejected ? "renewed-token" : "current-token",
            expiresAtEpochMs: 3_600_000,
          },
        };
      }),
    rememberCheckedDescriptor: () => Effect.void,
    renewDpopBeforeExpiry: () => Effect.die("HTTP requests must not renew a socket's token."),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("test-thumbprint"),
    createProof: (input) =>
      Effect.sync(() => {
        proofs.push(input);
        return `proof-${proofs.length}`;
      }),
  });
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    remoteAuthorization,
    signer,
    input: {
      prepared: PREPARED,
      signer: Option.some(signer),
      remoteAuthorization: Option.some(remoteAuthorization),
    },
    httpLayer: RpcHttp.layerRemoteHttpClient(fetchFn),
  };
}

type HttpInput = ReturnType<typeof makeHarness>["input"];

const ORCHESTRATION_LOADERS: ReadonlyArray<{
  readonly name: string;
  readonly response: unknown;
  readonly load: (input: HttpInput) => Effect.Effect<unknown, unknown, unknown>;
}> = [
  {
    name: "shell snapshot",
    response: SHELL,
    load: (input) => fetchEnvironmentShellSnapshot(input),
  },
  {
    name: "thread transcript",
    response: encodeThreadTranscript(TRANSCRIPT),
    load: (input) => fetchEnvironmentThreadTranscript({ ...input, threadId: TRANSCRIPT.threadId }),
  },
  {
    name: "bounded thread snapshot",
    response: encodeBoundedSnapshot(BOUNDED_THREAD),
    load: (input) =>
      fetchEnvironmentBoundedThreadSnapshot({ ...input, threadId: THREAD.projection.thread.id }),
  },
  {
    name: "older thread history",
    response: THREAD_HISTORY,
    load: (input) =>
      fetchEnvironmentThreadHistoryPage({
        ...input,
        threadId: THREAD.projection.thread.id,
        cursor: "older-page",
      }),
  },
];

describe("Voice environment HTTP auth", () => {
  it.effect.each(ORCHESTRATION_LOADERS)(
    "sends the voice history capability header on authenticated $name requests",
    (loader) =>
      Effect.gen(function* () {
        const harness = makeHarness(() => Response.json(loader.response));
        yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));
        expect(harness.calls).toHaveLength(1);
        expect(new Headers(harness.calls[0]?.init.headers).get(CLIENT_CAPABILITIES_HEADER)).toBe(
          VOICE_HISTORY_CAPABILITY,
        );
      }),
  );

  it.effect.each([
    "supported",
    "revoked",
    "unavailable",
    "legacy",
    "disabled",
    "different-environment",
    "legacy-different-environment",
  ] as const)("Live media-ticket startup distinguishes %s without exposing credentials", (state) =>
    Effect.gen(function* () {
      const harness = makeHarness(() =>
        state === "revoked"
          ? credentialRejectedResponse()
          : state === "unavailable"
            ? Response.json({}, { status: 503 })
            : Response.json({
                ticket: "fictional-media-ticket",
                expiresAt: "2099-01-01T00:00:00.000Z",
              }),
      );
      const descriptor = {
        environmentId:
          state === "different-environment" || state === "legacy-different-environment"
            ? EnvironmentId.make("other-environment")
            : PREPARED.environmentId,
        capabilities: {
          repositoryIdentity: false,
          ...(state === "legacy" || state === "legacy-different-environment"
            ? {}
            : { nativeLiveVoice: state !== "disabled" }),
        },
      };
      const result = yield* getEnvironmentLiveVoiceUrl(PREPARED, descriptor).pipe(
        Effect.provide(harness.httpLayer),
        Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, harness.signer),
        Effect.provideService(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
          harness.remoteAuthorization,
        ),
        Effect.result,
      );
      if (state === "supported") {
        expect(result._tag).toBe("Success");
        if (result._tag === "Success")
          expect(new URL(result.success).pathname).toBe("/api/voice/live");
      } else {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "LiveVoiceStartupError",
            reason:
              state === "revoked"
                ? "environment-auth-required"
                : state === "legacy" || state === "disabled"
                  ? "unsupported-server"
                  : state === "different-environment" || state === "legacy-different-environment"
                    ? "connection-changed"
                    : "temporarily-unavailable",
          },
        });
        expect(JSON.stringify(result)).not.toMatch(
          /current-token|renewed-token|previous\.example|headers|Authorization/,
        );
      }
      expect(harness.calls).toHaveLength(
        state === "legacy" ||
          state === "disabled" ||
          state === "different-environment" ||
          state === "legacy-different-environment"
          ? 0
          : state === "revoked"
            ? 2
            : 1,
      );
      expect(
        harness.calls.every(
          (call) =>
            new URL(call.url).pathname === "/api/auth/websocket-ticket/media" &&
            call.init.redirect === "error",
        ),
      ).toBe(true);
    }),
  );
});
