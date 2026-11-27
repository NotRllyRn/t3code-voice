type Catalog = Readonly<Record<string, unknown>>;

const VOICE_CATALOGS: Readonly<Record<string, () => Catalog>> = {
  es: () => require("./voice-translations/es.json"),
  zh: () => require("./voice-translations/zh.json"),
  "pt-BR": () => require("./voice-translations/pt-BR.json"),
  fr: () => require("./voice-translations/fr.json"),
  de: () => require("./voice-translations/de.json"),
  ja: () => require("./voice-translations/ja.json"),
  ko: () => require("./voice-translations/ko.json"),
  ru: () => require("./voice-translations/ru.json"),
  sv: () => require("./voice-translations/sv.json"),
};

export function mergeVoiceCatalog(locale: string, base: unknown): unknown {
  const voice = VOICE_CATALOGS[locale]?.();
  if (!voice) return base;
  return typeof base === "object" && base !== null ? { ...base, ...voice } : voice;
}
