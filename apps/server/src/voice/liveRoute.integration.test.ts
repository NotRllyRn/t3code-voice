// @effect-diagnostics-next-line nodeBuiltinImport:off -- fictional loopback HTTP/WS boundary, no provider calls.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  LIVE_VOICE_PATH,
  ProviderInstanceId,
  ProviderDriverKind,
  type LiveVoiceServerEvent,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { liveVoiceRouteLayer } from "./liveRoute.ts";
import { VoiceOwners } from "./owner.ts";
import { VoiceWebSocket } from "./transport.ts";
import { connection, sdp } from "./liveTestkit.ts";
import createFixture from "./fixtures/live-create-http.json" with { type: "json" };

const responses = [
  { name: "source SDP", phase: null },
  { name: "MIME case and parameters", contentType: "Application/SDP; charset=utf-8", phase: null },
  { name: "source plain text", contentType: createFixture.cases[1]!.contentType, phase: "mime" },
  { name: "non-ASCII", body: createFixture.body.replace("s=-", "s=é"), phase: "sdp" },
  { name: "HTML", body: "<html>fictional-private-response</html>", phase: "sdp" },
  { name: "JSON envelope", body: JSON.stringify({ sdp: createFixture.body }), phase: "sdp" },
  { name: "SDP limit", body: "v=0\r\ns=" + "x".repeat(65536), phase: "sdp" },
  { name: "body limit", body: "v=0\r\ns=" + "x".repeat(73728), phase: "body-size" },
  { name: "invalid UTF-8", body: Buffer.from([0x76, 0x3d, 0x30, 0x0a, 0xff]), phase: "body-utf8" },
  {
    name: "redirect",
    status: 307,
    location: "/redirect-must-not-follow",
    phase: null,
    rejected: true,
    unknownCall: true,
  },
  {
    name: "error 200",
    status: 200,
    body: "<html>fictional-private-response</html>",
    phase: null,
    rejected: true,
  },
  {
    name: "invalid call ID",
    location: "/v1/live/..%2Fpoison",
    phase: "location",
    unknownCall: true,
  },
] as const;
type CreateResponse = (typeof responses)[number];
const fixture = (variant: CreateResponse) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: { url: string; authorization: string | undefined; body: string }[] = [];
      const http = NodeHttp.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push({ url: request.url!, authorization: request.headers.authorization, body });
          if (request.url?.endsWith("/hangup")) {
            response.writeHead(200);
            response.end();
          } else {
            response.writeHead("status" in variant ? variant.status : createFixture.status, {
              "cOnTent-TyPe":
                "contentType" in variant
                  ? variant.contentType
                  : createFixture.cases[0]!.contentType,
              Location:
                "location" in variant
                  ? variant.location
                  : "https://never-follow.example.test/live/fake-owned",
            });
            response.end("body" in variant ? variant.body : createFixture.body);
          }
        });
      });
      const ws = new NodeWS.WebSocketServer({ server: http });
      const sideband: string[] = [];
      ws.on("connection", (socket, request) => {
        requests.push({
          url: request.url!,
          authorization: request.headers.authorization,
          body: "",
        });
        socket.on("message", (frame) => sideband.push(frame.toString()));
        socket.send(
          '{"type":"session.started","session":{"id":"fake-native-session","model":"gpt-live-1.1-codex"}}',
        );
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fictional loopback port");
      return { http, ws, requests, sideband, origin: `http://127.0.0.1:${address.port}` };
    }),
    (up) =>
      Effect.promise(async () => {
        up.ws.clients.forEach((client) => client.terminate());
        await new Promise<void>((resolve) => up.http.close(() => resolve()));
        up.ws.close();
      }),
  );

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-live-route-test-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.live.each(responses)(
  "real route + source-backed HTTP response $name + owned cleanup; no private response material",
  (variant) =>
    Effect.scoped(
      Effect.gen(function* () {
        const up = yield* fixture(variant);
        const logs: unknown[] = [];
        const owners = new Set<string>();
        const selected = { ...connection, createUrl: `${up.origin}/prefix/v1/live` };
        const provider: ProviderInstance = {
          instanceId: ProviderInstanceId.make("selected-instance"),
          enabled: true,
          driverKind: ProviderDriverKind.make("codex"),
          displayName: undefined,
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: "fixture-selected",
          },
          liveConnection: { resolveLiveConnection: () => Effect.succeed(selected) },
          get snapshot(): never {
            throw new Error("Live route must not inspect the public snapshot");
          },
          get orchestrationAdapter(): never {
            throw new Error("Live route must not create a second coding executor");
          },
          get textGeneration(): never {
            throw new Error("Live route must not generate provider text");
          },
        };
        const services = yield* Layer.build(
          HttpRouter.serve(
            liveVoiceRouteLayer.pipe(
              Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
              Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
              Layer.provide(
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/fixture/projects",
                }),
              ),
              Layer.provide(
                Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                  getInstance: () => Effect.succeed(provider),
                }),
              ),
              Layer.provide(Layer.succeed(VoiceOwners, owners)),
            ),
            { disableListenLog: true },
          ).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(NodeHttp.createServer, {
                host: "127.0.0.1",
                port: 0,
                websocket: { WebSocket: VoiceWebSocket, perMessageDeflate: false },
              }),
            ),
            Layer.provideMerge(authLayer),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(
              Logger.layer([Logger.make(({ message, cause }) => logs.push({ message, cause }))], {
                mergeWithExisting: false,
              }),
            ),
          ),
        );
        const sessions = Context.get(services, SessionStore.SessionStore);
        const session = yield* sessions.issue({ scopes: [AuthOrchestrationOperateScope] });
        const origin = HttpServer.formatAddress(
          Context.get(services, HttpServer.HttpServer).address,
        ).replace(/^http/, "ws");
        const readOnly = yield* sessions.issue({ scopes: [AuthOrchestrationReadScope] });
        const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
        const base = origin.replace(/^ws/, "http") + LIVE_VOICE_PATH;
        for (const [url, token, expected] of [
          [base, undefined, 401],
          [base, readOnly.token, 403],
          [base + "?apiKey=poison", session.token, 400],
        ] as const) {
          const response = yield* http.execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeaders(token ? { Authorization: `Bearer ${token}` } : {}),
            ),
          );
          expect(response.status).toBe(expected);
          yield* response.text;
        }
        expect(up.requests).toHaveLength(0);
        const draft = {
          modelSelection: { instanceId: "selected-instance", model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        };
        const browser = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new NodeWS.WebSocket(
                `${origin}${LIVE_VOICE_PATH}?draft=${encodeURIComponent(JSON.stringify(draft))}`,
                { headers: { Authorization: `Bearer ${session.token}` } },
              ),
          ),
          (socket) => Effect.sync(() => socket.terminate()),
        );
        const seen: LiveVoiceServerEvent[] = [];
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              browser.on("error", reject);
              browser.on("message", (raw) => {
                const event = JSON.parse(raw.toString()) as LiveVoiceServerEvent;
                seen.push(event);
                if (
                  event.type === "live.status" &&
                  event.phase === "connecting" &&
                  event.attemptId &&
                  !seen.some((frame) => frame.type === "live.answer")
                ) {
                  if (
                    seen.filter(
                      (frame) => frame.type === "live.status" && frame.phase === "connecting",
                    ).length === 1
                  )
                    browser.send(
                      JSON.stringify({
                        type: "live.start",
                        attemptId: event.attemptId,
                        offerSdp: sdp,
                      }),
                    );
                }
                if (event.type === "live.answer")
                  browser.send(
                    JSON.stringify({
                      type: "live.peer",
                      attemptId: event.attemptId,
                      state: "connected",
                    }),
                  );
                if (event.type === "live.status" && event.phase === "connected")
                  browser.send('{"type":"live.stop"}');
              });
              browser.on("close", () => resolve());
            }),
        );
        const rejected = variant.phase !== null || "rejected" in variant;
        expect(up.requests.map((request) => request.url)).toEqual([
          "/prefix/v1/live",
          ...(!rejected ? ["/prefix/v1/live/fake-owned"] : []),
          ...(!("unknownCall" in variant) ? ["/prefix/v1/realtime/calls/fake-owned/hangup"] : []),
        ]);
        if (variant.phase !== null) {
          expect(JSON.stringify(logs)).toContain(`"failurePhase":"${variant.phase}"`);
        }
        if (rejected) {
          expect(
            seen.some((event) => event.type === "live.status" && event.phase === "error"),
          ).toBe(true);
          expect(seen.some((event) => event.type === "live.answer")).toBe(false);
          expect(up.sideband).toEqual([]);
        }
        expect(
          up.requests.every((request) => request.authorization === "Bearer fictional-selected-key"),
        ).toBe(true);
        expect(JSON.parse(up.requests[0]!.body).session.delegation).toEqual({ type: "client" });
        expect(
          seen.some((event) => event.type === "live.status" && event.phase === "connected"),
        ).toBe(!rejected);
        // The answer itself must reach the browser; response material must never enter logs,
        // status/error events, or any rejected answer.
        expect(
          JSON.stringify({ seen: seen.filter((event) => event.type !== "live.answer"), logs }),
        ).not.toMatch(
          /fictional-selected-key|never-follow|fake-owned|fictional-private-response|fictionalUfrag|fictionalPassword|123456789|AA:AA|0\.0\.0\.0/,
        );
        expect(JSON.stringify(logs)).not.toContain("127.0.0.1");
        expect(owners.size).toBe(0);
      }),
    ).pipe(Effect.timeout("15 seconds")),
);
