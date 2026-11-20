import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  type ProviderInstanceConfigMap,
  type ProviderInstanceEnvironment,
  type ResolvedProviderInstanceEnvironment,
  type SecretReference,
} from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

describe("ProviderInstanceRegistry stored secrets and retirement", () => {
  const driverKind = ProviderDriverKind.make("fake");
  const instanceId = ProviderInstanceId.make("fake_main");
  const secret: SecretReference = {
    provider: SecretProviderId.make("personal"),
    reference: "op://Private/OpenAI/credential",
  };

  function setup(
    initial: Record<string, string>,
    configSchema: AnyProviderDriver["configSchema"] = Schema.Unknown,
    config: unknown = {},
    environment: ProviderInstanceEnvironment = [
      { name: "OPENAI_API_KEY", value: secret, sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ],
  ) {
    const vault = new Map(Object.entries(initial));
    const reads: Array<ReadonlyArray<string>> = [];
    const invalidated: Array<ReadonlyArray<string>> = [];
    const stored = new Map<string, string>();
    const storeReads: string[] = [];
    const storeFailures = new Set<string>();
    const created: Array<ResolvedProviderInstanceEnvironment> = [];
    const closed: ProviderInstanceId[] = [];
    const configs: Array<unknown> = [];
    const driver: AnyProviderDriver = {
      driverKind,
      metadata: { displayName: "Fake" },
      configSchema,
      defaultConfig: () => ({}),
      create: (input) =>
        Effect.gen(function* () {
          created.push(input.environment);
          configs.push(input.config);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(input.instanceId);
            }),
          );
          return { instanceId: input.instanceId, enabled: input.enabled } as ProviderInstance;
        }),
    };
    const gate = Deferred.makeUnsafe<void>();
    const resolver = Layer.succeed(SecretResolver.SecretResolver, {
      label: (provider) => Effect.succeed(provider),
      read: (references) =>
        Deferred.await(gate).pipe(
          Effect.andThen(
            Effect.sync(() => {
              reads.push(references.map((reference) => reference.reference));
              return references.map((reference) => vault.get(reference.reference));
            }),
          ),
        ),
      invalidate: (references = []) =>
        Effect.sync(() => {
          invalidated.push(references.map((reference) => reference.reference));
        }),
    });
    const configMap: ProviderInstanceConfigMap = {
      [instanceId]: {
        driver: driverKind,
        config,
        environment,
      },
    };
    const makeGated = makeProviderInstanceRegistry({ drivers: [driver], configMap }).pipe(
      Effect.provide(resolver),
      Effect.provideService(ServerSecretStore.ServerSecretStore, {
        get: (name) =>
          Effect.suspend(() => {
            storeReads.push(name);
            return storeFailures.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStoreReadError({
                    resource: "test slot",
                    cause: "DO_NOT_LEAK",
                  }),
                )
              : Effect.succeed(
                  Option.fromNullishOr(stored.get(name)).pipe(
                    Option.map((value) => new TextEncoder().encode(value)),
                  ),
                );
          }),
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        remove: () => Effect.void,
      }),
    );
    // Secrets are read after startup, so wait for the change that applies them.
    const make = Effect.gen(function* () {
      const built = yield* makeGated;
      const changes = yield* built.registry.subscribeChanges;
      yield* Deferred.succeed(gate, undefined);
      yield* PubSub.take(changes);
      return built;
    });
    return {
      vault,
      reads,
      invalidated,
      stored,
      storeReads,
      storeFailures,
      created,
      closed,
      configs,
      configMap,
      make,
      makeGated,
      gate,
    };
  }

  const storedSlot = `provider-env-${Buffer.from(instanceId).toString("base64url")}-${Buffer.from("OPENAI_API_KEY").toString("base64url")}`;
  const storedVariable = {
    name: "OPENAI_API_KEY",
    value: "untrusted-materialized-value",
    sensitive: true,
    valueRedacted: true,
  };

  it.effect.each(["success", "missing", "empty", "failure"] as const)(
    "uses only a successful server-store read (%s)",
    (scenario) => {
      const fixture = setup({}, Schema.Unknown, {}, [storedVariable]);
      if (scenario === "success") fixture.stored.set(storedSlot, "stored-current");
      if (scenario === "empty") fixture.stored.set(storedSlot, " ");
      if (scenario === "failure") fixture.storeFailures.add(storedSlot);
      return Effect.gen(function* () {
        const { registry, mutator } = yield* fixture.makeGated;
        expect(fixture.storeReads).toEqual([storedSlot]);
        if (scenario !== "success") {
          expect(yield* registry.getInstance(instanceId)).toBeUndefined();
          expect(fixture.created).toEqual([]);
          expect(JSON.stringify(yield* registry.listUnavailable)).not.toMatch(
            /DO_NOT_LEAK|untrusted-materialized-value/,
          );
          fixture.storeFailures.clear();
          fixture.stored.set(storedSlot, "stored-recovered");
          yield* mutator.reloadSecrets(instanceId);
          expect(fixture.created.at(-1)?.[0]?.value).toBe("stored-recovered");
          return;
        }
        expect(fixture.created.at(-1)?.[0]?.value).toBe("stored-current");
        fixture.stored.set(storedSlot, "stored-rotated");
        yield* mutator.reloadSecrets(instanceId);
        expect(fixture.created.at(-1)?.[0]?.value).toBe("stored-rotated");
        fixture.storeFailures.add(storedSlot);
        yield* mutator.reloadSecrets(instanceId);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();
        expect(fixture.created).toHaveLength(2);
        expect(fixture.closed).toEqual([instanceId, instanceId]);
      });
    },
  );

  it.effect.each([
    { ...storedVariable, valueRedacted: false },
    { ...storedVariable, sensitive: false },
    { name: "OPENAI_API_KEY", value: "literal", sensitive: false },
    { ...storedVariable, name: "OTHER_API_KEY" },
  ])(
    "does not read a stored credential from a literal or sensitive flag alone ($name)",
    (variable) => {
      const fixture = setup({}, Schema.Unknown, {}, [variable]);
      fixture.stored.set(storedSlot, "stored-current");
      return Effect.gen(function* () {
        yield* fixture.makeGated;
        expect(fixture.storeReads).toEqual([]);
      });
    },
  );

  it.effect.each([true, false])(
    "keeps stored duplicate order and checked refresh current (stored first %s)",
    (storedFirst) => {
      const literal = { name: "OPENAI_API_KEY", value: "literal-override", sensitive: true };
      const fixture = setup({ [secret.reference]: "external-current" }, Schema.Unknown, {}, [
        ...(storedFirst ? [storedVariable, literal] : [literal, storedVariable]),
        { name: "EXTERNAL_KEY", value: secret, sensitive: true },
      ]);
      fixture.stored.set(storedSlot, "stored-current");
      return Effect.gen(function* () {
        const { registry, mutator } = yield* fixture.make;
        fixture.stored.set(storedSlot, "stored-checked-current");
        yield* mutator.applySecret(secret, "external-current");
        expect(
          fixture.created
            .at(-1)
            ?.slice(0, 2)
            .map(({ value }) => value),
        ).toEqual(
          storedFirst
            ? ["stored-checked-current", "literal-override"]
            : ["literal-override", "stored-checked-current"],
        );
        fixture.storeFailures.add(storedSlot);
        yield* mutator.applySecret(secret, "external-checked-new");
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();
        expect(fixture.created).toHaveLength(2);
        expect(fixture.closed).toEqual([instanceId, instanceId]);
      });
    },
  );

  it.effect.each([true, false])(
    "rotates only original reference slots with reference first %s",
    (referenceFirst) => {
      const reference = { name: "OPENAI_API_KEY", value: secret, sensitive: true };
      const literal = { name: "OPENAI_API_KEY", value: "literal-override", sensitive: true };
      const fixture = setup(
        { [secret.reference]: "initial-reference" },
        Schema.Unknown,
        {},
        referenceFirst ? [reference, literal] : [literal, reference],
      );
      return Effect.gen(function* () {
        const { mutator } = yield* fixture.make;
        const reads = fixture.reads.length;
        yield* mutator.applySecret(secret, "checked-rotation");
        expect(fixture.reads).toHaveLength(reads);
        const expected = referenceFirst
          ? ["checked-rotation", "literal-override"]
          : ["literal-override", "checked-rotation"];
        expect(fixture.created.at(-1)?.map(({ value }) => value)).toEqual(expected);
        expect(
          Object.fromEntries(fixture.created.at(-1)!.map(({ name, value }) => [name, value])),
        ).toEqual({
          OPENAI_API_KEY: expected.at(-1),
        });
        fixture.vault.set(secret.reference, "resolver-rotation");
        yield* mutator.reloadSecrets(instanceId);
        expect(fixture.created.at(-1)?.map(({ value }) => value)).toEqual(
          referenceFirst
            ? ["resolver-rotation", "literal-override"]
            : ["literal-override", "resolver-rotation"],
        );
      });
    },
  );

  it.effect("uses a checked value when initially resolving parked reference slots", () => {
    const fixture = setup({});
    return Effect.gen(function* () {
      const { registry, mutator } = yield* fixture.make;
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      const reads = fixture.reads.length;
      yield* mutator.applySecret(secret, "initial-checked-value");
      expect(fixture.reads).toHaveLength(reads);
      expect(fixture.created.at(-1)?.[0]?.value).toBe("initial-checked-value");
    });
  });

  it.effect("parks retired clean Pi settings without starting a driver", () =>
    Effect.gen(function* () {
      let starts = 0;
      const pi = ProviderDriverKind.make("pi");
      const instanceId = ProviderInstanceId.make("retired-pi");
      const fake: AnyProviderDriver = {
        driverKind: pi,
        metadata: { displayName: "Pi" },
        configSchema: Schema.Unknown,
        defaultConfig: () => ({}),
        create: () =>
          Effect.sync(() => {
            starts++;
            return { instanceId, enabled: true } as ProviderInstance;
          }),
      };
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [fake],
        configMap: {
          [instanceId]: { driver: pi, enabled: true, config: { environmentMode: "clean" } },
        },
      });
      expect(starts).toBe(0);
      expect(yield* registry.getInstance(instanceId)).toBeUndefined();
      expect((yield* registry.listUnavailable)[0]?.unavailableReason).toContain("retired");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(SecretResolver.SecretResolver)({}),
          Layer.mock(ServerSecretStore.ServerSecretStore)({}),
        ),
      ),
    ),
  );
});
