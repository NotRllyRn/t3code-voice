// Fixed radix: changing it would break ordering against already installed signed bundles.
const REVISION_RADIX = 1000n;
// Conservative product bound, not an asserted Apple parser limit.
const MAX_COMPONENT = 2147483647n;

export function encodeVoiceMacVersion(version: string): string {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-voice\.([1-9][0-9]*)$/.exec(
    version,
  );
  if (!match || match[0] !== version) throw new Error("Unsupported Voice macOS version");
  const major = BigInt(match[1]!);
  const minor = BigInt(match[2]!);
  const patch = BigInt(match[3]!);
  const revision = BigInt(match[4]!);
  const nativePatch = patch * REVISION_RADIX + revision;
  if (
    revision >= REVISION_RADIX ||
    major > MAX_COMPONENT ||
    minor > MAX_COMPONENT ||
    nativePatch > MAX_COMPONENT
  )
    throw new Error("Voice macOS version exceeds native encoding bounds");
  return `${major}.${minor}.${nativePatch}`;
}

export function isVoiceMacBundleVersion(version: string, plist: unknown): boolean {
  if (
    typeof plist !== "object" ||
    plist === null ||
    !("ElectronSquirrelPreventDowngrades" in plist) ||
    plist.ElectronSquirrelPreventDowngrades !== true ||
    !("CFBundleShortVersionString" in plist)
  )
    return false;
  try {
    return plist.CFBundleShortVersionString === encodeVoiceMacVersion(version);
  } catch {
    return false;
  }
}
