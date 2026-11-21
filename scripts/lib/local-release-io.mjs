import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
const execute = NodeUtil.promisify(NodeChildProcess.execFile);

export async function githubApi(path) {
  try {
    const paged = path.includes("per_page=100");
    const { stdout } = await execute(
      "gh",
      ["api", "--hostname", "github.com", ...(paged ? ["--paginate", "--slurp"] : []), path],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const result = JSON.parse(stdout);
    return paged ? result.flat() : result;
  } catch {
    // A subprocess error includes its environment/arguments on some runtimes.
    throw new Error(
      "GitHub API request failed; check gh authentication, network and repository access",
    );
  }
}
export async function readAuthorization(path) {
  const info = await NodeFSP.lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Authorization must be a regular file");
  if (info.mode & 0o077) throw new Error("Authorization file must be private (chmod 600)");
  const value = (await NodeFSP.readFile(path, "utf8")).trim();
  if (!/^Bearer [^\s]+$/.test(value))
    throw new Error("Authorization file must contain one Bearer credential");
  return value;
}
export async function saveJson(path, value) {
  const tmp = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const file = await NodeFSP.open(tmp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await NodeFSP.rename(tmp, path);
    const directory = await NodeFSP.open(NodePath.dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await NodeFSP.rm(tmp, { force: true });
  }
}
export async function readJson(path) {
  try {
    const info = await NodeFSP.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error("State must be a private regular file");
    return JSON.parse(await NodeFSP.readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
/** flock holds the lock in the poller process itself; death releases it. Linux/util-linux. */
export async function runLocked(path, args) {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const parent = await NodeFSP.stat(NodePath.dirname(path));
  if (parent.mode & 0o077) throw new Error("State directory must be private (chmod 700)");
  const lock = `${path}.lock`;
  try {
    const info = await NodeFSP.lstat(lock);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe lock file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const file = await NodeFSP.open(lock, "a", 0o600);
  await file.close();
  // execve preserves the supervisor PID and the lock FD; no orphan wrapper on SIGKILL.
  const { stdout } = await execute("which", ["flock"], { timeout: 5_000 });
  process.execve(
    stdout.trim(),
    [
      "flock",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      "--no-fork",
      lock,
      process.execPath,
      ...args,
    ],
    {
      ...process.env,
      LOCAL_RELEASE_POLLER_LOCK: path,
    },
  );
}
function parseMcpJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("T3 MCP returned invalid JSON");
  }
}
export async function mcpSession(endpoint, authorization, fetcher = fetch) {
  let sessionId;
  let protocol = "2025-06-18";
  let serial = 0;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    "mcp-protocol-version": protocol,
  });
  async function send(message) {
    let response;
    try {
      response = await fetcher(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(message),
        redirect: "error",
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new Error("T3 MCP request failed or timed out; pending request retained for retry");
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`T3 MCP HTTP ${response.status}`);
    }
    const body = await response.text();
    if (!body.trim()) return [];
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return body.split(/\r?\n\r?\n/).flatMap((frame) => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        return data ? [parseMcpJson(data)] : [];
      });
    }
    const parsed = parseMcpJson(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  async function request(method, params) {
    const id = ++serial;
    const responses = await send({ jsonrpc: "2.0", id, method, params });
    const result = responses.find((r) => r.id === id);
    if (!result || result.error) throw new Error(`T3 MCP ${method} failed`);
    return result.result;
  }
  async function close() {
    if (sessionId) {
      try {
        const response = await fetcher(endpoint, {
          method: "DELETE",
          headers: headers(),
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        await response.body?.cancel();
      } catch {
        /* The authenticated identity survives HTTP session cleanup. */
      }
    }
  }
  try {
    const initialized = await request("initialize", {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "local-release-poller", version: "1" },
    });
    protocol = initialized.protocolVersion;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    close,
    async call(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      if (result.isError)
        throw new Error(`T3 tool ${name} failed; inspect server/thread for details`);
      const structured =
        result.structuredContent ??
        parseMcpJson(result.content?.find((part) => part.type === "text")?.text ?? "null");
      if (!structured || typeof structured !== "object")
        throw new Error(`T3 tool ${name} returned no structured result`);
      return structured;
    },
  };
}
