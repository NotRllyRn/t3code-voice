import * as Schema from "effect/Schema";
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Keep grounding turns even when recent generated speech fills the history window. */
export function selectLiveHistory<T extends { role: string; text: string; voice?: unknown }>(
  rows: ReadonlyArray<T>,
): T[] {
  const priorities = [
    rows.findLastIndex((row) => row.role === "user"),
    rows.findLastIndex((row) => row.role === "assistant" && !row.voice),
    ...rows.map((_, index) => index).reverse(),
  ];
  const kept = new Set<number>();
  for (const index of priorities) {
    if (index < 0 || kept.has(index) || kept.size === 4) continue;
    const next = [...kept, index].sort((a, b) => a - b).map((index) => rows[index]!);
    if (Buffer.byteLength(stringify(next), "utf8") <= 12000) kept.add(index);
  }
  return [...kept].sort((a, b) => a - b).map((index) => rows[index]!);
}
