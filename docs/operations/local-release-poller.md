# Local upstream release poller

A small Linux process watches GitHub's latest stable upstream release. It starts an upgrade agent in a new T3 Code worktree. The agent resolves conflicts, opens a draft PR after its first commit, tests, reviews, merges, and publishes a fork prerelease. It does not deploy production or install GitHub workflows.

One state file keeps one upgrade active. New releases coalesce while the agent is busy. Once it stops, the newest target goes to the same thread and open PR. A new thread starts only after the previous PR merged, its matching prerelease was published with assets, and the worker stayed idle across two polls. A failed run, closed unmerged PR, or missing release remains visible for repair; it is never counted as delivered.

This is a dispatcher, not a replacement for release validation. Builds, signing, tests, and release quality depend on the worker and its configured tools. Budget and council limits in its prompt are instructions, not enforced spending limits.

## Requirements

- Node 26.13.1+, GitHub CLI (`gh`), Linux `flock` from util-linux.
- `gh auth login`, with access to both repositories. The worker separately needs push/merge/release rights.
- A running T3 Code server supporting `t3_thread_launch`, `t3_thread_send`, and `t3_thread_read`, with a registered fork project and working agent provider.
- The project has an `origin` remote pointing at the fork. Its configured base branch must include your latest shipped fork changes.
- Local build/signing tools and any required build hosts already available to the agent.

## Configure

Keep configuration, credentials, and state outside the checkout:

```sh
install -d -m 700 "$HOME/.config/release-poller"
cp scripts/local-release-poller.example.json "$HOME/.config/release-poller/config.json"
chmod 600 "$HOME/.config/release-poller/config.json"
```

Edit the example. Set repositories, project ID, branches, MCP endpoint, provider/model, and `accepted` to the upstream tag and exact commit **already integrated in your shipped fork**. Do not set it to an unintegrated release just to silence the poller. `authorizationFile` and `stateFile` are relative to the configuration file. `instructions` adds your release requirements; keep secrets out of it. Omitting `modelSelection` uses the project's default.

`intervalSeconds` defaults in the example to 300. Detection is normally within that interval while the host, GitHub, and T3 are available. This polls releases, not every main-branch commit. It uses GitHub's `/releases/latest`, not highest version sorting. Tags must be stable `vMAJOR.MINOR.PATCH` (optional `v`), target the configured upstream branch or exact release commit, and descend from the previous target. Annotated tags are supported; moved tags fail visibly.

## Authorize once

The poller needs its own persistent **full-access MCP credential** to launch unattended workers. Use a normal T3 pairing code, with standard scopes, from the server's Connections UI or matching installed CLI. Do not put it in command arguments or commit it.

On the server, capture the CLI output privately (add `--base-dir` if needed):

```sh
umask 077
t3 pair --label 'Local release poller' > "$HOME/.config/release-poller/pairing.txt"
node scripts/local-release-poller.mjs authorize \
  "$HOME/.config/release-poller/config.json" \
  "$HOME/.config/release-poller/pairing.txt"
rm "$HOME/.config/release-poller/pairing.txt"
```

Alternatively save only the pairing code in that private file. Authorization uses T3's normal OAuth PKCE flow. It writes the bearer credential to `authorizationFile` with mode 600, never stdout. It refuses to overwrite an existing credential. T3 credentials currently expire after 30 days; there is no refresh-token support.

## Verify and run

From the checkout:

```sh
node scripts/local-release-poller.mjs check "$HOME/.config/release-poller/config.json"
node scripts/local-release-poller.mjs dry-run "$HOME/.config/release-poller/config.json"
node --test scripts/local-release-poller.test.mjs
node scripts/local-release-poller.mjs once "$HOME/.config/release-poller/config.json"
```

`check` tests read access to GitHub and the T3 project. `dry-run` reports the next action without saving state or sending agent work. Neither proves build tools or signing work. `once` may start a real, full-access upgrade immediately if upstream is newer.

For continuous operation:

```sh
node scripts/local-release-poller.mjs watch "$HOME/.config/release-poller/config.json"
```

Use your existing process supervisor to keep that command running across logouts/reboots. There is no repository-specific service required. Stop with Ctrl+C or SIGTERM; the OS releases the lock even after a crash. This stops polling, **not an already launched agent**. Open its thread in T3 to stop or resume its work.

```sh
node scripts/local-release-poller.mjs status "$HOME/.config/release-poller/config.json"
```

Status includes desired/accepted upstream commits, active thread, and any pending request. Logs report dispatch and attention states. The `.lock` file can remain on disk after exit; its presence does not mean a process holds it. Run only one installation/state file per fork and base branch. Two different state files cannot coordinate with each other.

## Recovery

- **Network/server failure:** retry automatically at the next interval. Pending calls retain their exact request ID and arguments, preventing duplicate work under the same MCP identity.
- **Agent failed or needs input:** open its existing thread. Resolve the issue and resume there. The poller does not repeatedly restart failed agents or invent successful releases.
- **PR merged, release missing:** finish the release in the existing thread. Published notes must contain `Upstream-Commit: <exact upstream SHA>` on its own line. The prerelease tag must contain that PR's merge commit, and assets must exist. This marker identifies the upstream target; it is not a test certificate.
- **PR closed unmerged:** reopen it and resume, or deliberately reconcile the state after reviewing the abandoned work. No automatic replacement PR.
- **Lost/corrupt state:** restore its backup. Do not delete it to retry: a worker may already exist even before its PR does. Startup refuses an existing open `upgrade/upstream-*` PR without state, but cannot reconstruct a lost pre-PR thread.
- **Expired/revoked credential:** stop the poller. If `pending` is non-null, first inspect T3 to determine whether that exact operation happened; do not replay it under another identity. Once no request is uncertain, archive the old credential privately, run `authorize` again, then restart. A new credential is accepted only with no pending operation.
- **Authorization fails:** the reserved credential file may be empty. Remove that empty file before retrying; never remove a working credential to bypass an uncertain pending request.

The poller reads GitHub facts; the worker creates and links the PR. GitHub cannot create a PR from an unchanged branch, so the draft appears after the first real upgrade commit. It preserves one branch through newer targets while that PR stays open. No empty commits or tracking-only PRs are created.
