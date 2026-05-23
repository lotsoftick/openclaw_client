# TweetClaw X/Twitter Workflows

Use this guide when an OpenClaw Client agent needs live X/Twitter context through
TweetClaw. The workflow keeps OpenClaw Client responsible for agents,
conversations, skills, plugins, Cron jobs, channel delivery, and workspace files
while TweetClaw provides X/Twitter automation through the OpenClaw plugin
runtime.

## What TweetClaw Adds

TweetClaw is the `@xquik/tweetclaw` OpenClaw plugin. It supports:

- Scrape tweets and search tweets.
- Search tweet replies.
- Post tweets and post tweet replies after review.
- Export followers and look up users.
- Upload media and download authenticated media.
- Send direct messages after review.
- Monitor tweets and deliver webhook-backed events.
- Run giveaway draws.

Use it when a Client conversation needs source-linked X/Twitter research,
audience notes, launch monitoring, support triage, campaign reporting, or an
approval-gated publish workflow.

## Install

Run plugin setup in the same shell where `openclaw --version` and
`openclaw auth status` already work.

```bash
openclaw plugins install @xquik/tweetclaw
openclaw plugins inspect tweetclaw --runtime
openclaw skills info tweetclaw
```

TweetClaw installs before credentials exist. In that state, agents can use the
free `explore` catalog, while live calls return setup guidance until credentials
are configured.

## Configure Credentials Safely

Do not paste API keys, signing keys, account cookies, passwords, or one-time
codes into OpenClaw Client chat, workspace files, Cron messages, issue reports,
or screenshots.

For account-backed X/Twitter automation, create an API key in the Xquik
dashboard and pass it through an environment variable:

```bash
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
```

For read-only pay-per-use access without an account, configure the MPP signing
key instead:

```bash
openclaw config set plugins.entries.tweetclaw.config.tempoSigningKey "$MPP_SIGNING_KEY"
```

MPP mode is read-only. Use API key mode for post tweets, post tweet replies,
direct messages, monitors, webhooks, media upload, media download, extraction
jobs, and giveaway draws.

## Enable Tools For Agents

OpenClaw can keep external plugin tools outside the default coding profile. If
an agent can read the TweetClaw skill but cannot call its tools, add the two
tool names without replacing the normal profile:

```bash
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Then open OpenClaw Client:

1. Go to **Plugins** and confirm TweetClaw is listed as an installed plugin.
2. Enable it if the plugin row is disabled.
3. Go to **Skills** and search for `tweetclaw`.
4. Open the target agent settings.
5. If **Skills allowlist** is not inheriting defaults, turn on `tweetclaw` for
   that agent.
6. Restart the service or wait for the plugin and skill cache to refresh.

```bash
openclaw_client restart
```

## Chat Prompt Recipes

Use prompts that ask the agent to gather evidence first and ask before any
write-like action.

```text
Search tweets and tweet replies about our launch keywords from the last 24
hours. Return the top 10 source URLs, author handles, timestamps, reply context,
and a short audience-insight summary. Do not post anything.
```

```text
Monitor our brand handle and 3 competitor handles for launch questions. Save a
daily summary with tweet URLs, suggested replies, and priority. Ask before
posting any reply.
```

```text
Find giveaway entries for this tweet, deduplicate by author, and prepare the
draw criteria for review. Do not select winners until I approve the criteria.
```

```text
Draft 3 reply options for these tweets using the attached launch brief. Include
the source tweet URL beside each draft. Ask before posting.
```

## Cron Job Recipes

OpenClaw Client Cron jobs can send scheduled messages to a selected agent. Keep
the Cron message self-contained and avoid putting secrets in it.

### Daily Launch Monitor

- Schedule type: **Cron Expression**
- Example schedule: `0 9 * * *`
- Agent: launch or marketing agent
- Message:

```text
Use TweetClaw to review monitored X/Twitter events for our launch keywords.
Summarize new tweets, replies, source URLs, author handles, suggested actions,
and blockers. Do not post, send DMs, upload media, or change monitors without
approval.
```

### Weekly Follower Export Review

- Schedule type: **Cron Expression**
- Example schedule: `0 10 * * 1`
- Agent: audience or growth agent
- Message:

```text
Use TweetClaw to export follower context for the approved account and compare it
with last week's workspace summary. Report notable audience changes, repeated
support questions, and 5 follow-up ideas. Do not DM or post.
```

### Webhook Follow-Up

If TweetClaw webhooks feed the workflow, keep OpenClaw Client focused on review
and response planning:

```text
Review new TweetClaw webhook events saved in the workspace. Group them by
monitor, include source URLs, and propose responses that require approval before
posting.
```

## Workspace Notes

Store only reviewed outputs in workspace files:

- Source tweet URLs or IDs.
- Public author handles.
- Capture dates.
- Short summaries and decisions.
- Approved reply drafts.
- Follow-up tasks.

Do not store raw API keys, signing keys, account cookies, passwords, one-time
codes, raw direct message bodies, large raw follower exports, or unreviewed
post text in workspace files.

## Approval Boundaries

Treat these TweetClaw actions as approval-gated in OpenClaw Client sessions:

- Post tweets.
- Post tweet replies.
- Send direct messages.
- Upload media.
- Download authenticated media into a shareable report.
- Create, update, or delete monitors.
- Create or change webhooks.
- Run giveaway draws.
- Any action that spends account credits or changes public state.

The agent may prepare plans, summaries, drafts, and structured request previews
before approval. Review the source URLs, account, request body, media, and
intended public text before approving.

## Troubleshooting

If the plugin does not appear in OpenClaw Client:

```bash
openclaw plugins list --json
openclaw plugins inspect tweetclaw --runtime
openclaw_client restart
```

If the skill appears but the tools are unavailable:

```bash
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

If live calls return setup guidance, configure either `apiKey` or
`tempoSigningKey`. If write-like calls are needed, use API key mode.

## Links

- [TweetClaw GitHub repository](https://github.com/Xquik-dev/tweetclaw)
- [TweetClaw npm package](https://www.npmjs.com/package/@xquik/tweetclaw)
- [Xquik platform](https://xquik.com)
- [Xquik API docs](https://docs.xquik.com)
