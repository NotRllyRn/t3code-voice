// @effect-diagnostics nodeBuiltinImport:off -- Synchronous POSIX runner fixture uses real tools and an isolated filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

const version = "0.1.10-voice.10";
const mirror = "https://mirror.invalid/releases?signature=synthetic%2Btoken&expires=123";

// Run the real generated shell with an allowlisted PATH. No network tool or
// provider executable from the host is reachable by the runner.
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-ssh-regression-"));
  const bin = NodePath.join(root, "bin");
  const home = NodePath.join(root, "home");
  const forkHome = NodePath.join(root, "fork home\nwith newline");
  const release = NodePath.join(root, "release");
  const downloads = NodePath.join(root, "downloads");
  const executions = NodePath.join(root, "executions");
  const archive = `t3-${version}-linux-x64.tar.gz`;
  for (const dir of [bin, home, NodePath.join(release, "t3")])
    NodeFS.mkdirSync(dir, { recursive: true });
  const executable =
    '#!/bin/sh\nprintf "executed\\n" >> "$FIXTURE_EXECUTIONS"\nprintf "synthetic-runtime"; printf " <%s>" "$@"; printf "\\n"\n';
  NodeFS.writeFileSync(NodePath.join(release, "t3", "t3"), executable, { mode: 0o755 });
  NodeChildProcess.execFileSync("tar", ["-czf", archive, "t3"], { cwd: release, timeout: 10_000 });
  const checksum = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(release, archive)))
    .digest("hex");
  const checksums = NodePath.join(release, "SHA256SUMS");
  NodeFS.writeFileSync(checksums, `${checksum}  ${archive}\n`);
  for (const tool of [
    "sh",
    "mkdir",
    "mktemp",
    "cat",
    "rm",
    "grep",
    "cut",
    "sha256sum",
    "tar",
    "gzip",
    "mv",
  ]) {
    const source = NodeChildProcess.execFileSync("sh", ["-c", 'command -v "$1"', "sh", tool], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    NodeFS.symlinkSync(source, NodePath.join(bin, tool));
  }
  const script = (name: string, body: string) =>
    NodeFS.writeFileSync(NodePath.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  script("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) exit 90 ;; esac');
  script(
    "curl",
    `
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) url="$1" ;;
    -o) shift; output="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$FIXTURE_DOWNLOADS"
case "$url" in
  '${mirror.replace("/releases?", `/releases/v${version}/SHA256SUMS?`)}') file=SHA256SUMS ;;
  '${mirror.replace("/releases?", `/releases/v${version}/${archive}?`)}') file='${archive}' ;;
  *) exit 91 ;;
esac
cat "$FIXTURE_RELEASE/$file" > "$output"`,
  );
  const runner = NodePath.join(root, "runner.sh");
  NodeFS.writeFileSync(
    runner,
    buildRemoteT3RunnerScript({ archiveVersion: version, releaseBaseUrl: mirror }),
  );
  const runtime = NodePath.join(forkHome, "runtime", "versions", version);
  return {
    root,
    home,
    forkHome,
    runtime,
    checksums,
    archive,
    executable,
    downloads,
    executions,
    run: () =>
      NodeChildProcess.spawnSync(
        NodePath.join(bin, "sh"),
        [runner, "argument with spaces", "--version"],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            HOME: home,
            PATH: bin,
            TMPDIR: root,
            T3CODE_VOICE_HOME: forkHome,
            FIXTURE_RELEASE: release,
            FIXTURE_DOWNLOADS: downloads,
            FIXTURE_EXECUTIONS: executions,
          },
        },
      ),
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

it("installs a verified archive only in the overridden fork home, then runs offline from cache", () => {
  using f = fixture();
  const result = f.run();
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("synthetic-runtime <argument with spaces> <--version>\n");
  expect(NodeFS.readFileSync(NodePath.join(f.runtime, "t3"), "utf8")).toBe(f.executable);
  expect(NodeFS.readFileSync(NodePath.join(f.runtime, ".install-complete"), "utf8")).toBe(
    `${version}\n`,
  );
  expect(NodeFS.readFileSync(f.executions, "utf8")).toBe("executed\nexecuted\n");
  const requested = NodeFS.readFileSync(f.downloads, "utf8");
  expect(requested.trim().split("\n")).toEqual([
    mirror.replace("/releases?", `/releases/v${version}/SHA256SUMS?`),
    mirror.replace("/releases?", `/releases/v${version}/${f.archive}?`),
  ]);
  expect(NodeFS.readdirSync(f.home)).toEqual([]);
  expect(NodeFS.readdirSync(NodePath.dirname(f.runtime))).toEqual([version]);
  NodeFS.rmSync(f.checksums);
  const cached = f.run();
  expect(cached.status, cached.stderr).toBe(0);
  expect(cached.stdout).toBe(result.stdout);
  expect(NodeFS.readFileSync(f.downloads, "utf8")).toBe(requested);
  expect(NodeFS.readFileSync(f.executions, "utf8")).toBe("executed\nexecuted\nexecuted\n");
});

it("rejects a corrupt checksum without publishing a runtime and permits a clean retry", () => {
  using f = fixture();
  const valid = NodeFS.readFileSync(f.checksums);
  NodeFS.writeFileSync(f.checksums, `${"0".repeat(64)}  ${f.archive}\n`);
  const rejected = f.run();
  expect(rejected.error).toBeUndefined();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain("Checksum mismatch");
  expect(rejected.stdout).toBe("");
  expect(NodeFS.existsSync(f.executions)).toBe(false);
  expect(NodeFS.existsSync(f.runtime)).toBe(false);
  expect(NodeFS.readdirSync(NodePath.dirname(f.runtime))).toEqual([]);
  expect(NodeFS.readdirSync(f.home)).toEqual([]);
  NodeFS.writeFileSync(f.checksums, valid);
  const retried = f.run();
  expect(retried.status, retried.stderr).toBe(0);
  expect(retried.stdout).toBe("synthetic-runtime <argument with spaces> <--version>\n");
});

it("recovers a dead installer lock and replaces an incomplete runtime before execution", () => {
  using f = fixture();
  const exited = NodeChildProcess.spawnSync("/bin/sh", ["-c", "exit 0"], { timeout: 10_000 });
  expect(exited.status).toBe(0);
  expect(exited.pid).toBeGreaterThan(0);
  NodeFS.mkdirSync(f.runtime, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(f.runtime, "t3"), "#!/bin/sh\nexit 73\n", {
    mode: 0o755,
  });
  const lock = NodePath.join(NodePath.dirname(f.runtime), `.${version}.install.lock`);
  NodeFS.writeFileSync(lock, `${exited.pid}\n`);
  const recovered = f.run();
  expect(recovered.error).toBeUndefined();
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(recovered.stdout).toBe("synthetic-runtime <argument with spaces> <--version>\n");
  expect(NodeFS.readFileSync(NodePath.join(f.runtime, "t3"), "utf8")).toBe(f.executable);
  expect(NodeFS.readFileSync(NodePath.join(f.runtime, ".install-complete"), "utf8")).toBe(
    `${version}\n`,
  );
  expect(NodeFS.readdirSync(NodePath.dirname(f.runtime))).toEqual([version]);
  expect(NodeFS.readdirSync(f.home)).toEqual([]);
});
