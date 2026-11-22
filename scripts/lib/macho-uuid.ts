// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

export function rewriteMachOUuids(input: Buffer, identity: string): Buffer {
  const offsets: Array<{ offset: number; cpu: number; subtype: number }> = [];
  const requireValid = (condition: boolean) => {
    if (!condition) throw new Error("Invalid executable Mach-O UUID layout");
  };
  const thin = (start: number, size: number, expected?: readonly [number, number]) => {
    requireValid(size >= 28);
    const magic = input.readUInt32BE(start);
    const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
    const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
    requireValid(little || magic === 0xfeedface || magic === 0xfeedfacf);
    const read = (offset: number) =>
      little ? input.readUInt32LE(start + offset) : input.readUInt32BE(start + offset);
    const header = wide ? 32 : 28;
    requireValid(size >= header && read(12) === 2);
    const cpu = read(4);
    const subtype = read(8);
    requireValid(!expected || (cpu === expected[0] && subtype === expected[1]));
    const commands = read(16);
    const commandBytes = read(20);
    requireValid(commandBytes <= size - header && commands <= commandBytes / 8);
    const end = header + commandBytes;
    let cursor = header;
    let uuidCount = 0;
    for (let index = 0; index < commands; index++) {
      requireValid(cursor + 8 <= end);
      const command = read(cursor);
      const length = read(cursor + 4);
      requireValid(length >= 8 && length % (wide ? 8 : 4) === 0 && length <= end - cursor);
      if (command === 0x1b) {
        requireValid(length === 24);
        offsets.push({ offset: start + cursor + 8, cpu, subtype });
        uuidCount++;
      }
      cursor += length;
    }
    requireValid(cursor === end && uuidCount === 1);
  };
  requireValid(input.length >= 4);
  const magic = input.readUInt32BE(0);
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    requireValid(input.length >= 8);
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const read = (offset: number) =>
      little ? input.readUInt32LE(offset) : input.readUInt32BE(offset);
    const count = read(4);
    const entrySize = wide ? 32 : 20;
    requireValid(count > 0 && count <= (input.length - 8) / entrySize);
    const headerEnd = 8 + count * entrySize;
    const ranges: Array<readonly [number, number]> = [];
    const architectures = new Set<string>();
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * entrySize;
      const integer = (offset: number) => {
        const value = wide
          ? little
            ? input.readBigUInt64LE(offset)
            : input.readBigUInt64BE(offset)
          : BigInt(read(offset));
        requireValid(value <= BigInt(input.length));
        return Number(value);
      };
      const start = integer(entry + 8);
      const size = integer(entry + (wide ? 16 : 12));
      const alignment = read(entry + (wide ? 24 : 16));
      requireValid(alignment <= 63 && BigInt(start) % (1n << BigInt(alignment)) === 0n);
      requireValid(start >= headerEnd && size <= input.length - start);
      requireValid(ranges.every(([other, end]) => start + size <= other || start >= end));
      const cpu = read(entry);
      const subtype = read(entry + 4);
      const architecture = `${cpu}:${subtype}`;
      requireValid(!architectures.has(architecture));
      architectures.add(architecture);
      ranges.push([start, start + size]);
      thin(start, size, [cpu, subtype]);
    }
  } else {
    thin(0, input.length);
  }
  const output = Buffer.from(input);
  for (const { offset, cpu, subtype } of offsets) {
    // Fork identities deliberately no longer match upstream Electron dSYMs.
    const uuid = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify(["io.github.notrllyrn.t3codevoice/macho-uuid/v1", identity, cpu, subtype]),
      )
      .digest()
      .subarray(0, 16);
    uuid[6] = (uuid[6]! & 0x0f) | 0x80;
    uuid[8] = (uuid[8]! & 0x3f) | 0x80;
    uuid.copy(output, offset);
  }
  return output;
}
