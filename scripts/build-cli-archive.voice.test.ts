import { assert, it } from "@effect/vitest";

import { linuxLibatomicHeader } from "./build-cli-archive.ts";

it("uses the installed distro and source version for libatomic provenance", () => {
  const pkg = {
    pkg: "libatomic1",
    version: "14.2.0-19",
    sourcePackage: "gcc-14",
    sourceVersion: "1:14.2.0-19",
  };
  assert.strictEqual(
    linuxLibatomicHeader('ID="debian"\nID_LIKE=ubuntu\n', pkg),
    "libatomic.so.1 is copied from the Debian package libatomic1 14.2.0-19.\n" +
      "Source: https://sources.debian.org/src/gcc-14/1%3A14.2.0-19/",
  );
  assert.strictEqual(
    linuxLibatomicHeader("ID=ubuntu\n", pkg),
    "libatomic.so.1 is copied from the Ubuntu package libatomic1 14.2.0-19.\n" +
      "Source: https://launchpad.net/ubuntu/+source/gcc-14/1%3A14.2.0-19",
  );
  assert.isUndefined(linuxLibatomicHeader("ID=other\nID_LIKE=debian\n", pkg));
});
