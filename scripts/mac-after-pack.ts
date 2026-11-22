// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import Plist from "plist";
import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import { rewriteMachOUuids } from "./lib/macho-uuid.ts";

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

const prepareServerCompileCache: (context: AfterPackContext) => Promise<void> =
  NodeModule.createRequire(import.meta.url)("./prepare-server-compile-cache.cjs");

export default async function afterPack(context: AfterPackContext): Promise<void> {
  await prepareServerCompileCache(context);
  if (context.electronPlatformName !== "darwin") return;
  const app = NodePath.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const frameworks = NodePath.join(app, "Contents/Frameworks");
  const helpers = (await NodeFSP.readdir(frameworks, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => NodePath.join(frameworks, entry.name));
  const changes = [];
  for (const bundle of [app, ...helpers]) {
    const info = Plist.parse(
      await NodeFSP.readFile(NodePath.join(bundle, "Contents/Info.plist"), "utf8"),
    );
    if (
      typeof info !== "object" ||
      info === null ||
      !("CFBundleIdentifier" in info) ||
      !("CFBundleExecutable" in info)
    )
      throw new Error("Missing executable bundle identity");
    const identifier = info.CFBundleIdentifier;
    const executableName = info.CFBundleExecutable;
    if (
      typeof identifier !== "string" ||
      (bundle === app
        ? identifier !== FORK_DESKTOP.appId
        : !["helper", "helper.GPU", "helper.Plugin", "helper.Renderer"].some(
            (suffix) => identifier === `${FORK_DESKTOP.appId}.${suffix}`,
          )) ||
      typeof executableName !== "string" ||
      NodePath.basename(executableName) !== executableName
    )
      throw new Error("Unexpected fork executable bundle identity");
    const executable = NodePath.join(bundle, "Contents/MacOS", executableName);
    if (!(await NodeFSP.lstat(executable)).isFile())
      throw new Error("Expected regular bundle executable");
    const input = await NodeFSP.readFile(executable);
    const output = rewriteMachOUuids(
      input,
      NodePath.relative(app, executable).split(NodePath.sep).join("/"),
    );
    changes.push({ executable, output });
  }
  // Cache generation above must run before UUID edits invalidate Electron's vendor signatures.
  for (const { executable, output } of changes) await NodeFSP.writeFile(executable, output);
}
