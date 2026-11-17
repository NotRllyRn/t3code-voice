// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { PiSettings } from "../settings.ts";
import {
  readResolvedEnvironmentSecrets,
  type ResolvedEnvironmentSecrets,
} from "@t3tools/provider-core/server/instanceEnvironment";

class PiEnvironmentError extends Schema.TaggedError<PiEnvironmentError>()("PiEnvironmentError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Pi clean startup requires private dedicated directories, trusted PATH directories, and an absolute native binary or Node script.";
  }
}

function absolutePath(value: string): string {
  if (!NodePath.isAbsolute(value) || value.includes("\0") || value.includes(":")) {
    throw new Error("Clean Pi paths must be absolute and cannot contain PATH delimiters.");
  }
  return NodeFS.realpathSync(value);
}

function privateDirectory(value: string): string {
  const path = absolutePath(value);
  const stat = NodeFS.statSync(path);
  if (
    path !== NodePath.resolve(value) ||
    path === NodePath.parse(path).root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Clean Pi directories must be canonical, user-owned and private.");
  }
  return path;
}

function trustedPath(value: string, directory: boolean): string {
  const path = absolutePath(value);
  const stat = NodeFS.statSync(path);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Clean Pi executable and PATH entries must not be writable by other users.");
  }
  NodeFS.accessSync(path, NodeFS.constants.X_OK);
  return path;
}

export interface PiExecutable {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function executableHeader(path: string): Buffer {
  const fd = NodeFS.openSync(path, "r");
  try {
    const bytes = Buffer.alloc(256);
    const length = NodeFS.readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, length);
  } finally {
    NodeFS.closeSync(fd);
  }
}

function isNative(header: Buffer): boolean {
  return [
    "7f454c46",
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
  ].includes(header.subarray(0, 4).toString("hex"));
}

function resolveExecutable(
  binaryPath: string,
  pathDirectories: ReadonlyArray<string>,
): PiExecutable {
  const path = trustedPath(binaryPath, false);
  const header = executableHeader(path);
  if (isNative(header)) return { command: path, args: [] };
  const shebang = header.toString("utf8").split("\n", 1)[0] ?? "";
  const match = /^#!\s*(\/usr\/bin\/env node|\/[^\s]+\/node)\s*$/.exec(shebang);
  if (match === null)
    throw new Error("Clean Pi does not support shell wrappers or non-Node interpreters.");
  const interpreter =
    match[1] === "/usr/bin/env node"
      ? pathDirectories
          .map((entry) => NodePath.join(entry, "node"))
          .find((entry) => {
            try {
              NodeFS.accessSync(entry, NodeFS.constants.X_OK);
              return !NodeFS.statSync(entry).isDirectory();
            } catch {
              return false;
            }
          })
      : match[1];
  if (interpreter === undefined) throw new Error("Clean Pi requires a trusted Node interpreter.");
  const node = trustedPath(interpreter, false);
  if (!isNative(executableHeader(node)))
    throw new Error("Clean Pi requires a native Node interpreter, not a shell wrapper.");
  // Execute the checked targets directly; neither env nor the kernel resolves the shebang again.
  return { command: node, args: [path] };
}

function validateModelsRegistry(agentDirectory: string): void {
  const path = NodePath.join(agentDirectory, "models.json");
  if (!NodeFS.existsSync(path)) return;
  let registry: unknown;
  try {
    registry = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    throw new Error("Clean Pi requires a valid operator models registry.");
  }
  const credentialReference = (value: unknown) =>
    value === "OPENAI_API_KEY" || value === "$OPENAI_API_KEY" || value === "${OPENAI_API_KEY}";
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.trimStart().startsWith("!"))
      throw new Error("Clean Pi does not allow command resolvers in its models registry.");
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "apiKey" && !credentialReference(child))
        throw new Error("Clean Pi registry credentials must reference OPENAI_API_KEY.");
      if (key === "headers") {
        if (
          child === null ||
          typeof child !== "object" ||
          Array.isArray(child) ||
          Object.entries(child).some(
            ([name, header]) =>
              !credentialReference(header) &&
              !(
                ["http-referer", "x-title"].includes(name.toLowerCase()) &&
                typeof header === "string"
              ),
          )
        )
          throw new Error("Clean Pi registry headers must reference OPENAI_API_KEY.");
      }
      visit(child);
    }
  };
  visit(registry);
}

export const resolvePiStartup = Effect.fn("Pi.resolveStartup")(function* (
  settings: PiSettings,
  inherited: NodeJS.ProcessEnv,
  environmentSecrets?: ResolvedEnvironmentSecrets,
) {
  if (settings.environmentMode === "inherit")
    return {
      environment: inherited,
      executable: { command: settings.binaryPath || "pi", args: [] } satisfies PiExecutable,
    };
  const platform = yield* HostProcess.Platform;
  return yield* Effect.try({
    try: () => {
      if (settings.environmentMode !== "clean" || platform === "win32") {
        throw new Error("Unsupported Pi startup environment mode or platform.");
      }
      if (
        tokenizeCliArgs(settings.launchArgs).some(
          (arg) => arg === "--api-key" || arg.startsWith("--api-key="),
        )
      ) {
        throw new Error("Clean Pi does not allow --api-key launch arguments.");
      }
      const config = settings.cleanEnvironment;
      if (config === undefined)
        throw new Error("Clean Pi requires explicit directory configuration.");
      const home = privateDirectory(config.home);
      const agentDirectory = privateDirectory(config.agentDirectory);
      const tempDirectory = privateDirectory(config.tempDirectory);
      if (
        home === NodeFS.realpathSync(NodeOS.homedir()) ||
        !agentDirectory.startsWith(`${home}${NodePath.sep}`) ||
        !tempDirectory.startsWith(`${home}${NodePath.sep}`) ||
        agentDirectory === tempDirectory
      ) {
        throw new Error(
          "Clean Pi requires a dedicated home with separate agent and temp directories.",
        );
      }
      if (config.pathDirectories.length === 0) throw new Error("Clean Pi requires a trusted PATH.");
      const pathDirectories = config.pathDirectories.map((entry) => trustedPath(entry, true));
      const executable = resolveExecutable(settings.binaryPath, pathDirectories);
      validateModelsRegistry(agentDirectory);
      const credentials: NodeJS.ProcessEnv = {};
      for (const secret of readResolvedEnvironmentSecrets(environmentSecrets)) {
        if (secret.name !== "OPENAI_API_KEY")
          throw new Error("Clean Pi only accepts the OPENAI_API_KEY secret reference.");
        if (secret.value.trim() === "" || secret.value.includes("\0"))
          throw new Error("Clean Pi requires a nonempty environment credential.");
        credentials.OPENAI_API_KEY = secret.value;
      }
      const environment: NodeJS.ProcessEnv = {
        ...credentials,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDirectory,
        PATH: pathDirectories.join(NodePath.delimiter),
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TMPDIR: tempDirectory,
        TMP: tempDirectory,
        TEMP: tempDirectory,
      };
      return { environment, executable };
    },
    catch: (cause) => new PiEnvironmentError({ cause }),
  });
});
