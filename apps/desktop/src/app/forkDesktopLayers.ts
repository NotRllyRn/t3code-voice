import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";

// Keep Settings' manual command controls; startup must not claim the shared t3 command.
export const cliCommandLayer = Layer.effect(
  DesktopCliCommand.DesktopCliCommand,
  Effect.map(DesktopCliCommand.DesktopCliCommand, (service) => ({
    ...service,
    installOnFirstLaunch: Effect.void,
  })),
).pipe(Layer.provide(DesktopCliCommand.layer));

// The upstream constructor only creates refs. With no import, take stays empty and
// complete has no marker to write; neither operation waits for load.
export const legacyLocalStorageLayer = Layer.effect(
  DesktopLegacyLocalStorage.DesktopLegacyLocalStorage,
  Effect.map(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, (service) => ({
    ...service,
    load: () => Effect.void,
  })),
).pipe(Layer.provide(DesktopLegacyLocalStorage.layer));
