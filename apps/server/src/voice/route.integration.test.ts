// @effect-diagnostics-next-line nodeBuiltinImport:off -- starts the real Node upgrade boundary with the production ws subclass.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it as test } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  REALTIME_VOICE_PATH,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { realtimeVoiceRouteLayer } from "./route.ts";
import { VoiceWebSocket } from "./transport.ts";

const key = "fictional-server-env-credential";
const threadId = ThreadId.make("voice-integration");
const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-env-test-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const startRoute = Effect.fn("voice.test.startRoute")(function* (
  variables: Record<string, string>,
) {
  const logs: unknown[] = [];
  const services = yield* Layer.build(
    HttpRouter.serve(
      realtimeVoiceRouteLayer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(id === threadId ? liveThreadShell(id) : null),
          }),
        ),
        Layer.provide(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () =>
              Effect.succeed({ enabled: true, driverKind: "codex" } as ProviderInstance),
          }),
        ),
      ),
      { disableListenLog: true },
    ).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
          websocket: { perMessageDeflate: true, WebSocket: VoiceWebSocket },
        }),
      ),
      Layer.provideMerge(authLayer),
      Layer.provide(
        SecretResolver.layer({ drivers: [], secretProviders: Effect.succeed({}) }).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: variables }))),
      Layer.provide(
        Logger.layer([Logger.make(({ message, cause }) => logs.push({ message, cause }))], {
          mergeWithExisting: false,
        }),
      ),
    ),
  );
  const sessions = Context.get(services, SessionStore.SessionStore);
  const auth = Context.get(services, EnvironmentAuth.EnvironmentAuth);
  const session = yield* sessions.issue({ scopes: [AuthOrchestrationOperateScope] });
  const server = Context.get(services, HttpServer.HttpServer);
  const origin = HttpServer.formatAddress(server.address);
  const url = `${origin}${REALTIME_VOICE_PATH}?threadId=${threadId}`;
  return { auth, sessions, session, url, logs };
});

const upstreamFixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected a loopback fixture port");
    const requests: Array<{ authorization: string | undefined; url: string | undefined }> = [];
    const updates: string[] = [];
    server.on("connection", (socket, request) => {
      requests.push({ authorization: request.headers.authorization, url: request.url });
      socket.on("message", (data) => {
        updates.push(data.toString());
        socket.send(JSON.stringify({ type: "session.updated", secret: key }));
      });
    });
    return {
      server,
      requests,
      updates,
      url: `ws://127.0.0.1:${address.port}/v1/realtime?model=fictional-model`,
    };
  }),
  ({ server }) =>
    Effect.promise(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
);

test.live(
  "starts the real authenticated route and keeps the env key only in the upstream header",
  () =>
    Effect.gen(function* () {
      const upstream = yield* upstreamFixture;
      const route = yield* startRoute({
        T3CODE_REALTIME_URL: upstream.url,
        T3CODE_REALTIME_API_KEY: key,
        UNRELATED_ENV_KEY: "fictional-unrelated-key",
      });
      const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const get = (url: string, token?: string) =>
        client.get(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const unauthenticated = yield* get(route.url);
      expect(unauthenticated.status).toBe(401);
      const reader = yield* route.sessions.issue({ scopes: [AuthOrchestrationReadScope] });
      expect((yield* get(route.url, reader.token)).status).toBe(403);
      expect(
        (yield* get(route.url.replace(threadId, "missing-thread"), route.session.token)).status,
      ).toBe(404);
      const wrongAudience = yield* route.auth.issueWebSocketTicket(route.session, { use: "rpc" });
      expect(
        (yield* get(`${route.url}&wsTicket=${Redacted.value(wrongAudience.ticket)}`)).status,
      ).toBe(401);
      expect(upstream.requests).toEqual([]);

      const ticket = yield* route.auth.issueWebSocketTicket(route.session, { use: "media" });
      const ready = Promise.withResolvers<string>();
      const ended = Promise.withResolvers<string>();
      const downstream = yield* Effect.acquireRelease(
        Effect.sync(() => {
          // Client query values cannot select an env name, credential, or upstream endpoint.
          const socket = new NodeWS.WebSocket(
            `${route.url.replace(/^http/, "ws")}&wsTicket=${Redacted.value(ticket.ticket)}&env=UNRELATED_ENV_KEY&apiKey=fictional-client-key&url=ws://192.0.2.1`,
          );
          socket.on("error", () => {
            ready.reject(new Error("Fixture downstream failed"));
            ended.reject(new Error("Fixture downstream failed"));
          });
          socket.on("message", (data) => {
            const frame = data.toString();
            if (frame.includes("relay.ready")) ready.resolve(frame);
            else ended.resolve(frame);
          });
          return socket;
        }),
        (socket) => Effect.sync(() => socket.terminate()),
      );
      expect(yield* Effect.promise(() => ready.promise)).toBe('{"type":"relay.ready"}');
      expect(upstream.requests).toEqual([
        { authorization: `Bearer ${key}`, url: "/v1/realtime?model=fictional-model" },
      ]);
      expect(upstream.updates).toHaveLength(1);
      expect(upstream.updates[0]).not.toContain(key);
      expect((yield* get(route.url, route.session.token)).status).toBe(409);
      // Even a credential-bearing upstream error must be replaced, not reflected or logged.
      for (const socket of upstream.server.clients)
        socket.send(
          JSON.stringify({ type: "error", message: key, authorization: `Bearer ${key}` }),
        );
      const message = yield* Effect.promise(() => ended.promise);
      expect(message).toContain('"type":"relay.error"');
      expect(message).not.toContain(key);
      const closed = new Promise<void>((resolve) => downstream.once("close", () => resolve()));
      downstream.close();
      yield* Effect.promise(() => closed);
      expect(JSON.stringify(route.logs)).not.toContain(key);
    }),
);

test.live.each([
  {},
  { T3CODE_REALTIME_API_KEY: " " },
  { T3CODE_REALTIME_API_KEY: "fictional\r\nInjected: header" },
  { T3CODE_REALTIME_API_KEY: key, T3CODE_REALTIME_SECRET_REF: "fictional-invalid-reference" },
  { T3CODE_REALTIME_SECRET_REF: '{"provider":"absent","reference":"op://Example/Voice/key"}' },
])(
  "fails closed over actual HTTP for missing, invalid, ambiguous or unresolved credentials %#",
  (variables) =>
    Effect.gen(function* () {
      const upstream = yield* upstreamFixture;
      const route = yield* startRoute({ T3CODE_REALTIME_URL: upstream.url, ...variables });
      const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
      const response = yield* client.get(
        `${route.url}&env=UNRELATED_ENV_KEY&apiKey=fictional-client-key`,
        {
          headers: { authorization: `Bearer ${route.session.token}` },
        },
      );
      expect(response.status).toBe(503);
      expect(yield* response.text).toBe("");
      expect(upstream.requests).toEqual([]);
      expect(JSON.stringify(route.logs)).not.toContain("fictional");
    }),
);
