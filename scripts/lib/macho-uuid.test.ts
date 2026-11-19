// @effect-diagnostics nodeBuiltinImport:off
import { expect, it } from "vite-plus/test";
import { rewriteMachOUuids } from "./macho-uuid.ts";

function thin(little = true, wide = true, cpu = 0x100000c) {
  const header = wide ? 32 : 28;
  const bytes = Buffer.alloc(header + 32, 0x5a);
  const write = (value: number, offset: number) =>
    little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  write(wide ? 0xfeedfacf : 0xfeedface, 0);
  write(cpu, 4);
  write(0, 8);
  write(2, 12);
  write(2, 16);
  write(32, 20);
  write(0x1b, header);
  write(24, header + 4);
  write(0x42, header + 24);
  write(8, header + 28);
  return { bytes, offsets: [header + 8] };
}

function fat(little = false, wide = false) {
  const first = thin();
  const second = thin(false, false, 7);
  const bytes = Buffer.alloc(256 + second.bytes.length);
  const write = (value: number, offset: number) =>
    little ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  write(wide ? 0xcafebabf : 0xcafebabe, 0);
  write(2, 4);
  for (const [index, cpu, start, source] of [
    [0, 0x100000c, 128, first.bytes],
    [1, 7, 256, second.bytes],
  ] as const) {
    const entry = 8 + index * (wide ? 32 : 20);
    write(cpu, entry);
    write(0, entry + 4);
    if (wide) {
      const write64 = (value: number, offset: number) =>
        little
          ? bytes.writeBigUInt64LE(BigInt(value), offset)
          : bytes.writeBigUInt64BE(BigInt(value), offset);
      write64(start, entry + 8);
      write64(source.length, entry + 16);
    } else {
      write(start, entry + 8);
      write(source.length, entry + 12);
    }
    write(7, entry + (wide ? 24 : 16));
    source.copy(bytes, start);
  }
  return { bytes, offsets: [128 + first.offsets[0]!, 256 + second.offsets[0]!] };
}

it.each([
  ["thin32be", () => thin(false, false)],
  ["thin32le", () => thin(true, false)],
  ["thin64be", () => thin(false, true)],
  ["thin64le", () => thin(true, true)],
  ["fat32be", () => fat(false, false)],
  ["fat32le", () => fat(true, false)],
  ["fat64be", () => fat(false, true)],
  ["fat64le", () => fat(true, true)],
] as const)(
  "rewrites only UUID bytes in %s, deterministically and idempotently",
  (_name, fixture) => {
    const { bytes, offsets } = fixture();
    const original = Buffer.from(bytes);
    const rewritten = rewriteMachOUuids(bytes, "Contents/MacOS/Voice");
    expect(bytes).toEqual(original);
    expect(rewriteMachOUuids(bytes, "Contents/MacOS/Voice")).toEqual(rewritten);
    expect(rewriteMachOUuids(rewritten, "Contents/MacOS/Voice")).toEqual(rewritten);
    const helper = rewriteMachOUuids(
      bytes,
      "Contents/Frameworks/Voice Helper.app/Contents/MacOS/Voice Helper",
    );
    const uuids = offsets.map((offset) => rewritten.subarray(offset, offset + 16).toString("hex"));
    expect(new Set(uuids).size).toBe(offsets.length);
    for (const offset of offsets) {
      expect(rewritten.subarray(offset, offset + 16)).not.toEqual(
        original.subarray(offset, offset + 16),
      );
      expect(rewritten.subarray(offset, offset + 16)).not.toEqual(
        helper.subarray(offset, offset + 16),
      );
      rewritten.copy(bytes, offset, offset, offset + 16);
    }
    expect(bytes).toEqual(rewritten);
  },
);

it.each([
  ["truncated header", () => Buffer.alloc(3)],
  ["unknown magic", () => Buffer.alloc(64)],
  [
    "dylib",
    () => {
      const { bytes } = thin();
      bytes.writeUInt32LE(6, 12);
      return bytes;
    },
  ],
  [
    "command outside slice",
    () => {
      const { bytes } = thin();
      bytes.writeUInt32LE(4096, 20);
      return bytes;
    },
  ],
  [
    "short command",
    () => {
      const { bytes } = thin();
      bytes.writeUInt32LE(4, 36);
      return bytes;
    },
  ],
  [
    "duplicate UUID",
    () => {
      const { bytes } = thin();
      bytes.writeUInt32LE(0x1b, 56);
      return bytes;
    },
  ],
  [
    "missing UUID",
    () => {
      const { bytes } = thin();
      bytes.writeUInt32LE(0x42, 32);
      return bytes;
    },
  ],
  [
    "truncated fat table",
    () => {
      const { bytes } = fat();
      bytes.writeUInt32BE(100, 4);
      return bytes;
    },
  ],
  [
    "overlapping slices",
    () => {
      const { bytes } = fat();
      bytes.writeUInt32BE(128, 36);
      return bytes;
    },
  ],
  [
    "wrong architecture",
    () => {
      const { bytes } = fat();
      bytes.writeUInt32BE(8, 28);
      return bytes;
    },
  ],
  [
    "fat64 overflow",
    () => {
      const { bytes } = fat(false, true);
      bytes.writeBigUInt64BE(2n ** 60n, 16);
      return bytes;
    },
  ],
  [
    "bad second slice",
    () => {
      const { bytes } = fat();
      bytes.writeUInt32BE(0, 256);
      return bytes;
    },
  ],
] as const)("rejects %s without mutating input", (_name, fixture) => {
  const bytes = fixture();
  const original = Buffer.from(bytes);
  expect(() => rewriteMachOUuids(bytes, "Contents/MacOS/Voice")).toThrow();
  expect(bytes).toEqual(original);
});
