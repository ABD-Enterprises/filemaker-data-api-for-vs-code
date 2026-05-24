# Cloud Agent — Claude Code on `ai/ready-for-work` tickets

This repo runs a Claude Code cloud agent that picks up GitHub issues labeled
`ai/ready-for-work`, plans + implements the scope, and opens a PR. Reviewers are
distinct from the implementer (separation-of-duties per Enterprise AI Standards).

> **Implementer**: Claude (this agent)
> **Reviewers**: `build-test`, `CodeQL`, `EAS Risk Label`, optional Gemini, and you on final merge

## How it fires

The workflow lives at [`.github/workflows/claude-code-agent.yml`](../.github/workflows/claude-code-agent.yml) and has two triggers:

| Trigger | When | How |
|---|---|---|
| **Auto** | A user adds the `ai/ready-for-work` label to an issue | Native GitHub event |
| **Manual** | You want to dry-run on a specific ticket | Actions tab → "Claude Code Agent" → Run workflow → enter issue number |

The agent only runs on issues that **currently** carry the `ai/ready-for-work` label — defensive check against label-race conditions.

## Setup (one-time)

### 1. Add the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (recommended)

This uses your existing **Claude Pro/Max subscription** — no pay-per-token API
charges. Generate the token locally:

```bash
claude setup-token
```

That prints a token like `sk-ant-oat01-...` (valid 1 year, tied to your
subscription, only works with Claude Code). Save it as a repo secret:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ABD-Enterprises/filemaker-data-api-for-vs-code
# paste the token when prompted
```

Or via the web UI: **Settings → Secrets and variables → Actions → New repository secret**.

> **Cost with this option**: $0 marginal. The action draws from your existing
> Claude Code subscription quota. You will hit the same rate limits as you
> would running Claude Code locally.

#### Fallback: `ANTHROPIC_API_KEY` (pay-per-token)

ONLY use this if you don't have a Claude Pro/Max subscription. Get a key from
https://console.anthropic.com/settings/keys and set it as `ANTHROPIC_API_KEY`.
Expect ~$1-5 per ticket. The workflow auto-selects OAuth if both are set.

### 2. (Recommended) Add a `PRS_PAT` repo secret

Without this, the PR opened by Claude uses the workflow's `GITHUB_TOKEN`. PRs
opened by `GITHUB_TOKEN` **do not trigger downstream workflows** — meaning
`build-test`, `CodeQL`, and `EAS` will NOT run on the PR until a human pushes
an additional commit. Auto-merge will stall.

To fix: create a fine-grained PAT with these permissions on this repo:

- **Contents**: Read and write
- **Pull requests**: Read and write
- **Issues**: Read and write

Add it as `PRS_PAT`. The workflow falls back to `GITHUB_TOKEN` if `PRS_PAT` is
unset, so this is recommended-not-required.

### 3. Verify the workflow is enabled

After this PR merges, **Settings → Actions → General** should show actions
enabled, and **Actions tab → All workflows** should list "Claude Code Agent".

## How to use it

### Run on a single ticket

1. Open the issue in GitHub.
2. Add the label `ai/ready-for-work`. (Or use `ai-pipeline transition ready_for_work --id <N>` locally.)
3. Within ~30 seconds, the agent will:
   - Move the ticket to `ai/in-development`
   - Post a "🤖 Claude Code cloud agent claimed this ticket" comment
   - Create a branch `claude/issue-<NUMBER>`
   - Implement the ticket
   - Open a PR linked to the issue
   - Move the ticket to `ai/in-pr-review`
4. Branch protection requires `build-test` + `CodeQL` to pass before you can merge. Review the diff, run `ai-pipeline validate-next` on your Mac if you want, then merge.

### Run on the existing queue (the 16 tickets from this session)

The 16 tickets currently in `ai/ready-for-work` will fire as soon as this
workflow merges (because the `labeled` event fires retroactively if you
re-apply the label).

If they don't fire automatically, kick them off via:

```bash
for n in 129 130 131 132 133 135 137 138 139 140 141 142 143 144 145 146; do
  gh workflow run claude-code-agent.yml -f issue_number=$n
  sleep 5
done
```

Or simpler: just remove + re-add the label on each ticket.

## What the agent CAN do

- Read any file in the repo
- Edit / write code, docs, CI workflows (within reason)
- Run `npm` scripts (lint, test, build, package)
- Open PRs, comment on issues, manage labels via `gh`
- Push to its own `claude/issue-<N>` branch

## What the agent CAN'T do

These are hard rules baked into the prompt + branch protection:

- Push directly to `main`
- Merge its own PRs
- Skip pre-commit hooks (`--no-verify`)
- Modify `.ai/` state files
- Touch other tickets while working on one
- Spend more than 60 minutes per run (job timeout)

## Cost

| Auth method | Per-ticket cost | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` (Pro/Max) | **$0 marginal** | Subscription absorbs it. Same rate limits as your local Claude Code. |
| `ANTHROPIC_API_KEY` (PAYG) | $1–5 | Billed separately. Set an account-level usage cap as a safety net. |

For the 16-ticket batch currently queued: $0 on subscription, or <$50 on PAYG.

## Failure handling

If the agent fails (timeout, API error, validation failure), the ticket
gets transitioned to `ai/blocked` with a comment linking to the failed
workflow run. Triage manually: read the run logs, decide whether to retry
(remove `ai/blocked`, add `ai/ready-for-work` again) or close the ticket.

## Cost-saving tips

- **Don't queue 16 tickets at once on first day** — the action's prompt
  caching helps but the first run for each ticket is uncached. Stagger.
- **Tighten ticket `scope`** before transitioning to `ai/ready-for-work`.
  Vague scopes burn tokens on exploration.
- **Disable the workflow** if not in use:
  `gh workflow disable claude-code-agent.yml`

## Troubleshooting

### Agent didn't pick up my labeled ticket

Check **Actions tab → All workflows → Claude Code Agent**. A run should be
visible within 30 seconds of the label add. If not:

- Verify `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY` fallback) is set
  in Settings → Secrets and variables → Actions.
- Verify the workflow is enabled.
- Verify the label name is exactly `ai/ready-for-work` (case-sensitive).
- If you're using OAuth: tokens expire after 1 year. Re-run
  `claude setup-token` locally and update the secret.

### PR opened but CI didn't run

This is the `GITHUB_TOKEN` limitation. Set `PRS_PAT` (see Setup step 2),
or push an empty commit to the branch:

```bash
gh pr checkout <PR_NUMBER>
git commit --allow-empty -m "ci: trigger checks"
git push
```

### Agent's PR has bad code

Reviewers exist to catch this. Comment on the PR. The next iteration of
the agent (when you re-label) will incorporate review feedback as part
of the prompt context.

### I want to stop the agent mid-run

Cancel the workflow run from the Actions tab. The ticket will remain in
`ai/in-development` — manually transition it back to `ai/ready-for-work`
or `ai/blocked` as appropriate.
