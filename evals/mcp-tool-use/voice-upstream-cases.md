# Voice upgrade deadline cases

`voice-upstream-cases.ts` calls the coordinator's existing `claimCandidate` with an offline GitHub fixture and disposable private state, then uses the returned launch message for two cases: an overdue/offline worker and an ordinary in-budget compatibility review. The overdue case checks completed disclosure of best-effort auditing, current-turn interrupt limits, queued/nested work, and stopping for operator reconciliation. Regex checks are bounded; review transcripts for false cancellation guarantees. All tools and shell actions remain simulated.

From the repository root, generate both arms with the same generator. The baseline loads the unmodified pre-fix coordinator and poller from `3660a1590edc0e834d85d29c9c90686666ba3ca1`; it needs no new prompt export. The candidate loads the current working source. Neither arm copies a prompt or launches a thread:

```sh
set -eu
baseline_source=$(mktemp -d)
trap 'rm -rf "$baseline_source"' EXIT
git archive 3660a1590edc0e834d85d29c9c90686666ba3ca1 \
  scripts/voice-upstream-coordinator.ts scripts/voice-upstream-poll.ts \
  packages/shared/src/forkIdentity.ts |
  tar -x -C "$baseline_source"
VOICE_UPSTREAM_COORDINATOR_SOURCE="$baseline_source/scripts/voice-upstream-coordinator.ts" \
  node evals/mcp-tool-use/voice-upstream-cases.ts > /tmp/voice-upstream-baseline.ndjson
node evals/mcp-tool-use/voice-upstream-cases.ts > /tmp/voice-upstream-candidate.ndjson
for arm in baseline candidate; do
  (cd evals && node mcp-tool-use/run.ts --cases "/tmp/voice-upstream-$arm.ndjson" \
    --model gpt-6-astra --shell-model gpt-6.1-terra --samples 3 --max-steps 4 \
    --concurrency 1 --dry-run)
done
```

The command above is offline and costs $0. A paid paired run replaces `--dry-run` with `--out runs/<arm>`, using separately generated baseline/candidate files and identical model/step/sample settings. Each arm is at most two cases × three samples × four steps, concurrency one. Proxy pricing is not recorded by this runner: confirm the model's current price and proxy authentication before authorizing either arm. No paid results are claimed for these cases yet.
