export function linuxLibatomicHeader(
  osRelease: string,
  input: {
    readonly pkg: string;
    readonly version: string;
    readonly sourcePackage: string;
    readonly sourceVersion: string;
  },
) {
  const match = /^ID=(?:"(debian|ubuntu)"|(debian|ubuntu))$/m.exec(osRelease);
  const distro = match?.[1] ?? match?.[2];
  if (!distro) return undefined;
  const sourcePackage = encodeURIComponent(input.sourcePackage);
  const sourceVersion = encodeURIComponent(input.sourceVersion);
  const source =
    distro === "debian"
      ? `https://sources.debian.org/src/${sourcePackage}/${sourceVersion}/`
      : `https://launchpad.net/ubuntu/+source/${sourcePackage}/${sourceVersion}`;
  return [
    `libatomic.so.1 is copied from the ${distro === "debian" ? "Debian" : "Ubuntu"} package ${input.pkg} ${input.version}.`,
    `Source: ${source}`,
  ].join("\n");
}
