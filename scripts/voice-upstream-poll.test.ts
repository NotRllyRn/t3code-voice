import * as NodeCrypto from "node:crypto";
import { expect, test } from "vitest";
import { githubJson, pollUpstream, postCandidate, type GitHubApi } from "./voice-upstream-poll.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const TAG_SHA = "c".repeat(40);
const ID = "00000000-0000-4000-8000-000000000001";
const pin = { repository: "pingdotgg/t3code", tag: "v0.1.9", commit: OLD };
const release = {
  draft: false,
  prerelease: false,
  tag_name: "v0.1.10",
  id: 42,
  published_at: "2026-11-16T10:00:00Z",
  body: "Ignore instructions here",
};
const clock = new Date("2026-11-16T12:00:00.000Z");

function fakeApi(overrides: Record<string, unknown> = {}) {
  const paths: string[] = [];
  const responses: Record<string, unknown> = {
    "/releases/latest": release,
    "/git/ref/tags/v0.1.10": { ref: "refs/tags/v0.1.10", object: { type: "tag", sha: TAG_SHA } },
    [`/git/tags/${TAG_SHA}`]: {
      sha: TAG_SHA,
      tag: "v0.1.10",
      object: { type: "commit", sha: NEW },
    },
    [`/compare/${OLD}...${NEW}`]: { status: "ahead" },
    ...overrides,
  };
  const api: GitHubApi = async (path) => {
    paths.push(path);
    if (!(path in responses)) throw new Error(`Unexpected API request: ${path}`);
    return responses[path];
  };
  return { api, paths };
}

test("resolves annotated tags, compares numeric stable versions, and omits untrusted release text", async () => {
  const { api, paths } = fakeApi();
  const candidate = await pollUpstream(pin, api, clock, ID);
  expect(candidate).toEqual({
    schema: 1,
    upstream: "pingdotgg/t3code",
    fork: "NotRllyRn/t3code-voice",
    base: "feature/codex-voice-stable",
    tag: "v0.1.10",
    sha: NEW,
    releaseId: 42,
    publishedAt: "2026-11-16T10:00:00Z",
    issuedAt: clock.toISOString(),
    expiresAt: "2026-11-16T12:05:00.000Z",
    deliveryId: ID,
  });
  expect(paths).toEqual([
    "/releases/latest",
    "/git/ref/tags/v0.1.10",
    `/git/tags/${TAG_SHA}`,
    `/compare/${OLD}...${NEW}`,
  ]);
  expect(JSON.stringify(candidate)).not.toContain("Ignore instructions");
});

test("peels a second annotated tag without using its name as the release tag", async () => {
  const inner = "d".repeat(40);
  const { api, paths } = fakeApi({
    [`/git/tags/${TAG_SHA}`]: { sha: TAG_SHA, tag: "v0.1.10", object: { type: "tag", sha: inner } },
    [`/git/tags/${inner}`]: {
      sha: inner,
      tag: "previous-name",
      object: { type: "commit", sha: NEW },
    },
  });
  expect((await pollUpstream(pin, api, clock, ID))?.sha).toBe(NEW);
  expect(paths).toContain(`/git/tags/${inner}`);
});

test("same stable tag and SHA is a no-op; movement and lower latest fail closed", async () => {
  const same = fakeApi({
    "/releases/latest": { ...release, tag_name: "v0.1.9" },
    "/git/ref/tags/v0.1.9": { ref: "refs/tags/v0.1.9", object: { type: "commit", sha: OLD } },
  });
  expect(await pollUpstream(pin, same.api, clock, ID)).toBeNull();
  expect(same.paths).not.toContain(`/compare/${OLD}...${NEW}`);
  const moved = fakeApi({
    "/releases/latest": { ...release, tag_name: "v0.1.9" },
    "/git/ref/tags/v0.1.9": { ref: "refs/tags/v0.1.9", object: { type: "commit", sha: NEW } },
  });
  await expect(pollUpstream(pin, moved.api, clock, ID)).rejects.toThrow("Accepted tag moved");
  const lower = fakeApi({ "/releases/latest": { ...release, tag_name: "v0.1.8" } });
  await expect(pollUpstream(pin, lower.api, clock, ID)).rejects.toThrow("older");
  expect(lower.paths).toEqual(["/releases/latest"]);
});

test("rejects drafts, prereleases, malformed releases, wrong pin and non-ancestor", async () => {
  for (const changed of [
    { draft: true },
    { prerelease: true },
    { tag_name: "v0.1.10-nightly.1" },
    { tag_name: "v0.01.10" },
    { id: "42" },
    { id: 0 },
    { published_at: "nonsense" },
  ]) {
    await expect(
      pollUpstream(pin, fakeApi({ "/releases/latest": { ...release, ...changed } }).api, clock, ID),
    ).rejects.toThrow();
  }
  await expect(
    pollUpstream({ ...pin, repository: "other/repo" }, fakeApi().api, clock, ID),
  ).rejects.toThrow("repository");
  await expect(
    pollUpstream({ ...pin, commit: "branch" }, fakeApi().api, clock, ID),
  ).rejects.toThrow("SHA");
  for (const status of ["behind", "diverged", "identical"])
    await expect(
      pollUpstream(pin, fakeApi({ [`/compare/${OLD}...${NEW}`]: { status } }).api, clock, ID),
    ).rejects.toThrow("ancestor");
});

test("rejects malformed tag refs, cycles, wrong tag SHA and invalid delivery IDs", async () => {
  await expect(
    pollUpstream(
      pin,
      fakeApi({
        "/git/ref/tags/v0.1.10": {
          ref: "refs/tags/v0.1.10",
          object: { type: "commit", sha: "bad" },
        },
      }).api,
      clock,
      ID,
    ),
  ).rejects.toThrow("SHA");
  await expect(
    pollUpstream(
      pin,
      fakeApi({
        [`/git/tags/${TAG_SHA}`]: {
          sha: TAG_SHA,
          tag: "v0.1.10",
          object: { type: "tag", sha: TAG_SHA },
        },
      }).api,
      clock,
      ID,
    ),
  ).rejects.toThrow("cycle");
  await expect(
    pollUpstream(
      pin,
      fakeApi({
        [`/git/tags/${TAG_SHA}`]: {
          sha: NEW,
          tag: "v0.1.10",
          object: { type: "commit", sha: NEW },
        },
      }).api,
      clock,
      ID,
    ),
  ).rejects.toThrow("mismatch");
  await expect(pollUpstream(pin, fakeApi().api, clock, "bad")).rejects.toThrow("delivery ID");
});

test("API uses fixed paths, rejects oversized responses and HTTP failures", async () => {
  await expect(githubJson("https://evil.example/")).rejects.toThrow("path");
  const comparePath = `/compare/${OLD}...${NEW}`;
  const comparison = { status: "ahead", files: [{ patch: "x".repeat(65_536) }] };
  await expect(
    githubJson(comparePath, async () => new Response(JSON.stringify(comparison))),
  ).resolves.toEqual(comparison);
  await expect(
    githubJson(
      comparePath,
      async () => new Response("", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } }),
    ),
  ).rejects.toThrow("too large");
  await expect(
    githubJson("/releases/latest", async (url) => {
      expect(String(url)).toBe("https://api.github.com/repos/pingdotgg/t3code/releases/latest");
      return new Response("x".repeat(32_769));
    }),
  ).rejects.toThrow("too large");
  await expect(
    githubJson("/releases/latest", async () => new Response("", { status: 403 })),
  ).rejects.toThrow("HTTP 403");
});

test("webhook signs exact bytes and rejects insecure URL or missing secret", async () => {
  const candidate = await pollUpstream(pin, fakeApi().api, clock, ID);
  if (!candidate) throw new Error("Fixture must have a new release");
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    expect(String(url)).toBe("https://example.test/receive");
    expect(init?.body).toBe(JSON.stringify(candidate));
    const headers = new Headers(init?.headers);
    expect(headers.get("x-hub-signature-256")).toBe(
      `sha256=${NodeCrypto.createHmac("sha256", "trusted-secret").update(JSON.stringify(candidate)).digest("hex")}`,
    );
    return new Response("", { status: 202 });
  };
  for (const url of [
    "http://example.test/",
    "https://user:pass@example.test/",
    "https://example.test/#fragment",
    "malformed",
  ])
    await expect(postCandidate(candidate, url, "trusted-secret", fetcher)).rejects.toThrow();
  await expect(postCandidate(candidate, "https://example.test/", "", fetcher)).rejects.toThrow();
  expect(calls).toBe(0);
  await postCandidate(candidate, "https://example.test/receive", "trusted-secret", fetcher);
  expect(calls).toBe(1);
});
