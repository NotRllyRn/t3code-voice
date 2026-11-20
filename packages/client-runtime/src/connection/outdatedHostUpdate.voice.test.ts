import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as Socket from "effect/socket/Socket";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { PrimaryConnectionTarget } from "./model.ts";
import { updateOutdatedHost } from "./outdatedHostUpdate.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-old"),
  label: "Build Mac",
  httpBaseUrl: "https://build.example.test",
  wsBaseUrl: "wss://build.example.test",
});

describe("Voice outdated host update", () => {
  it.effect.each(["manual", "upstream"] as const)(
    "refuses a %s host without opening an unverified updater socket",
    (kind) =>
      Effect.gen(function* () {
        const manual = {
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          platform: { os: "darwin" as const, arch: "arm64" },
          serverVersion: "0.0.45",
          capabilities:
            kind === "manual"
              ? { repositoryIdentity: true, voiceHistoryV1: true }
              : { repositoryIdentity: true, serverSelfUpdate: "boot-service" as const },
        } satisfies ExecutionEnvironmentDescriptor;
        let opened = false;
        const error = yield* Effect.flip(
          updateOutdatedHost(TARGET.environmentId, { targetVersion: "0.0.46" }, () => Effect.void),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(
                EnvironmentRegistry.EnvironmentRegistry,
                EnvironmentRegistry.EnvironmentRegistry.of({
                  entries: yield* SubscriptionRef.make<
                    ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
                  >(
                    new Map([
                      [
                        TARGET.environmentId,
                        { target: TARGET, profile: Option.none(), enabled: false },
                      ],
                    ]),
                  ),
                } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
              ),
              Layer.succeed(
                ConnectionResolver.ConnectionResolver,
                ConnectionResolver.ConnectionResolver.of({
                  prepare: () => Effect.die(new Error("unused")),
                  prepareForUpdate: () =>
                    Effect.succeed({
                      descriptor: manual,
                      prepared: {
                        environmentId: TARGET.environmentId,
                        label: TARGET.label,
                        httpBaseUrl: TARGET.httpBaseUrl,
                        socketUrl: "wss://build.example.test/ws",
                        httpAuthorization: null,
                        target: TARGET,
                      },
                    }),
                }),
              ),
              Layer.succeed(
                RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
                RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
                  state: yield* SubscriptionRef.make(
                    RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
                  ),
                  refresh: Effect.void,
                }),
              ),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die(new Error("unused"))),
              ),
              Layer.succeed(Socket.WebSocketConstructor, () => {
                opened = true;
                throw new Error("unused");
              }),
            ),
          ),
        );
        expect(error).toMatchObject({ _tag: "OutdatedHostUpdateError" });
        expect(opened).toBe(false);
      }),
  );
});
