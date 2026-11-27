import { describe, expect, it } from "vite-plus/test";

import { loadTranslations } from "./initializeI18n";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locales";

describe("web voice-translations overlay", () => {
  it("returns empty catalog for default locale", async () => {
    expect(await loadTranslations(DEFAULT_LOCALE)).toEqual({});
  });

  it("merges upstream and voice overlay translations for non-default locales", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      const merged = (await loadTranslations(locale)) as Record<string, unknown>;
      // Upstream key + fork-added key + fork-added rich-text array key
      expect(merged["6c6e16b9488f8b91"]).toBeTypeOf("string");
      expect(merged["0438581ab348645a"]).toBeTypeOf("string");
      expect(Array.isArray(merged["a2a69b830c6702d6"])).toBe(true);
    }
  });
});
