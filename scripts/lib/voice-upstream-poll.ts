// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Shared with the dependency-free Node sender's HMAC and ISO timestamp protocol.
import * as NodeCrypto from "node:crypto";

const UPSTREAM = "pingdotgg/t3code";
const FORK = "NotRllyRn/t3code-voice";
const API = `https://api.github.com/repos/${UPSTREAM}`;
const SHA = /^[a-f0-9]{40}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_BYTES = 32_768;

export type AcceptedPin = { repository: string; tag: string; commit: string };
export type Candidate = {
  schema: 1;
  upstream: typeof UPSTREAM;
  fork: typeof FORK;
  tag: string;
  sha: string;
  releaseId: number;
  publishedAt: string;
  issuedAt: string;
  expiresAt: string;
  deliveryId: string;
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid API object");
  return value as Record<string, unknown>;
}

function version(value: unknown): [number, number, number] {
  if (typeof value !== "string") throw new Error("Invalid stable tag");
  const parts = TAG.exec(value);
  if (!parts) throw new Error("Invalid stable tag");
  const numbers = parts.slice(1).map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n))) throw new Error("Invalid stable tag");
  return numbers as [number, number, number];
}

function commit(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("Invalid commit SHA");
  return value;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value.replace(/Z$/, ".000Z")
  )
    throw new Error("Invalid publication time");
  return value;
}

export function validatePin(value: unknown): AcceptedPin {
  const pin = object(value);
  if (pin.repository !== UPSTREAM) throw new Error("Unexpected pin repository");
  version(pin.tag);
  commit(pin.commit);
  return { repository: UPSTREAM, tag: pin.tag as string, commit: pin.commit as string };
}

export async function githubJson(path: string, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (
    !/^\/(?:releases\/latest|git\/ref\/heads\/main|git\/ref\/tags\/v\d+\.\d+\.\d+|git\/tags\/[a-f0-9]{40}|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40})$/.test(
      path,
    )
  )
    throw new Error("Unexpected GitHub API path");
  // Compare responses include file patches even when only ancestry is needed.
  const maxBytes = path.startsWith("/compare/") ? 16 * 1024 * 1024 : MAX_BYTES;
  const response = await fetcher(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "t3code-voice-upstream-poll",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes)
    throw new Error("GitHub response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty GitHub response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("GitHub response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export type GitHubApi = (path: string) => Promise<unknown>;

export async function pollUpstream(
  pinInput: unknown,
  api: GitHubApi,
  now: Date = new Date(),
  deliveryId: string = NodeCrypto.randomUUID(),
): Promise<Candidate | null> {
  const pin = validatePin(pinInput);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  const release = object(await api("/releases/latest"));
  if (release.draft !== false || release.prerelease !== false)
    throw new Error("Latest release is not stable");
  const next = version(release.tag_name);
  const order = compareVersions(next, version(pin.tag));
  if (order < 0) throw new Error("Latest release is older than accepted pin");
  if (!Number.isSafeInteger(release.id) || (release.id as number) <= 0)
    throw new Error("Invalid release ID");
  const publishedAt = timestamp(release.published_at);
  const tag = release.tag_name as string;
  const ref = object(await api(`/git/ref/tags/${tag}`));
  if (ref.ref !== `refs/tags/${tag}`) throw new Error("Tag ref mismatch");
  let target = object(ref.object);
  const seen = new Set<string>();
  for (let i = 0; i < 8 && target.type === "tag"; i++) {
    const tagSha = commit(target.sha);
    if (seen.has(tagSha)) throw new Error("Tag cycle");
    seen.add(tagSha);
    const annotated = object(await api(`/git/tags/${tagSha}`));
    if (annotated.sha !== tagSha || (seen.size === 1 && annotated.tag !== tag))
      throw new Error("Annotated tag mismatch");
    target = object(annotated.object);
  }
  if (target.type !== "commit") throw new Error("Tag does not resolve to a commit");
  const sha = commit(target.sha);
  if (release.target_commitish !== "main" && release.target_commitish !== sha)
    throw new Error("Release does not target the upstream main release line");
  if (order === 0) {
    if (sha !== pin.commit) throw new Error("Accepted tag moved");
    return null;
  }
  const mainRef = object(await api("/git/ref/heads/main"));
  const mainTarget = object(mainRef.object);
  if (mainRef.ref !== "refs/heads/main" || mainTarget.type !== "commit")
    throw new Error("Invalid upstream main ref");
  const mainSha = commit(mainTarget.sha);
  const mainAncestry = object(await api(`/compare/${sha}...${mainSha}`));
  if (mainAncestry.status !== "ahead" && mainAncestry.status !== "identical")
    throw new Error("Stable release is outside upstream main");
  const ancestry = object(await api(`/compare/${pin.commit}...${sha}`));
  if (ancestry.status !== "ahead") throw new Error("Accepted commit is not an ancestor");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryId))
    throw new Error("Invalid delivery ID");
  return {
    schema: 1,
    upstream: UPSTREAM,
    fork: FORK,
    tag,
    sha,
    releaseId: release.id as number,
    publishedAt,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    deliveryId,
  };
}

export async function postCandidate(
  candidate: Candidate,
  url: string,
  secret: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new Error("Webhook must be an HTTPS URL without credentials or fragment");
  if (!secret) throw new Error("Missing webhook secret");
  const body = JSON.stringify(candidate);
  const signature = NodeCrypto.createHmac("sha256", secret)
    .update(Buffer.from(body, "utf8"))
    .digest("hex");
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
  await response.body?.cancel();
}
