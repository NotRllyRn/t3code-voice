import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { PiSettings } from "./settings.ts";

const decode = Schema.decodeUnknownSync(PiSettings);

it("defaults to inherited startup and rejects unknown environment modes", () => {
  expect(decode({})).toHaveProperty("environmentMode", "inherit");
  expect(decode({ environmentMode: "clean" })).toHaveProperty("environmentMode", "clean");
  expect(() => decode({ environmentMode: "cleen" })).toThrow();
});
