import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

/** Uses T3's normal pairing approval + OAuth PKCE, without opening its database. */
export async function authorize(endpoint, codeFile, outputFile, fetcher = fetch) {
  const info = await NodeFSP.stat(codeFile);
  if (info.mode & 0o077) throw new Error("Pairing file must be private (chmod 600)");
  const text = (await NodeFSP.readFile(codeFile, "utf8")).trim();
  // Accept a raw pairing code or the private output of `t3 pair`.
  const code = /^Token: (\S+)$/m.exec(text)?.[1] ?? text;
  if (!code || /\s/.test(code))
    throw new Error("Pairing file must contain one code or t3 pair output");
  const origin = new URL(endpoint).origin;
  async function post(path, payload, form = false) {
    const response = await fetcher(`${origin}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(payload).toString() : JSON.stringify(payload),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`T3 authorization HTTP ${response.status}`);
    }
    return response.json();
  }
  // Never overwrite an existing identity: an uncertain launch may depend on it.
  const file = await NodeFSP.open(outputFile, "wx", 0o600);
  try {
    const redirect = "http://127.0.0.1:1/callback";
    const client = await post("/oauth/mcp/register", {
      client_name: "Local release poller",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    });
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const state = NodeCrypto.randomBytes(24).toString("base64url");
    const authorization = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect,
      resource: endpoint,
      code_challenge_method: "S256",
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      state,
    };
    const decision = await post("/oauth/mcp/decision", {
      authorization,
      decision: { _tag: "pairing-code", access: "full-access", code },
    });
    const callback = new URL(decision.redirectTo);
    if (
      callback.origin !== "http://127.0.0.1:1" ||
      callback.pathname !== "/callback" ||
      callback.searchParams.get("state") !== state ||
      !callback.searchParams.get("code")
    )
      throw new Error("Unexpected authorization response");
    const token = await post(
      "/oauth/mcp/token",
      {
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirect,
        code_verifier: verifier,
        code: callback.searchParams.get("code"),
        resource: endpoint,
      },
      true,
    );
    if (
      token.token_type?.toLowerCase() !== "bearer" ||
      typeof token.access_token !== "string" ||
      /\s/.test(token.access_token)
    )
      throw new Error("Unexpected token response");
    await file.writeFile(`Bearer ${token.access_token}\n`);
    await file.sync();
    return token.expires_in;
  } finally {
    await file.close();
  }
}
