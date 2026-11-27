import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";
import { mergeVoiceCatalog } from "./voiceCatalogs";

describe("mobile voiceCatalogs overlay", () => {
  it("returns base unchanged for default or unknown locale", () => {
    const base = { existing: "value" };
    expect(mergeVoiceCatalog(DEFAULT_LOCALE, base)).toBe(base);
    expect(mergeVoiceCatalog("xx", base)).toBe(base);
  });

  it("merges voice overlay keys over base catalog for every non-default locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const merged = mergeVoiceCatalog(locale, {
        upstreamKey: "kept",
        "0438581ab348645a": "overridden",
      }) as Record<string, unknown>;
      expect(merged.upstreamKey).toBe("kept");
      expect(merged["0438581ab348645a"]).toBeTypeOf("string");
      expect(merged["0438581ab348645a"]).not.toBe("overridden");
      expect(merged["c1ec7c26b17956e4"]).toBeTypeOf("string");
    }
  });
});
