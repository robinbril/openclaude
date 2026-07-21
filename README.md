# OpenClaude

Give any app or agent a free WhatsApp presence that runs on your **Claude Code
subscription seat**: no API key, no per-token cost. The model writes the
messages, a tiny host "bridge" does the I/O, and Kapso provides a free WhatsApp
number.

```
WhatsApp <-> Kapso <-> public tunnel <-> bridge (host) -> claude CLI (seat)
                                              ^-- your app / data source
```

It is packaged as a [Claude Code](https://docs.claude.com/en/docs/claude-code)
skill, but the bridge is plain Node and works on its own.

## What's inside

| File | What it is |
|------|------------|
| `SKILL.md` | The skill: how to grab the seat token, create the free WhatsApp number, and wire the triggers. |
| `assets/seat-bridge.template.mjs` | A complete, generic host bridge. `/health`, `/chat`, `/notify`, `/webhook`, a daily scheduler, an event poll, HMAC verification, and the seat call. No required npm deps. |
| `assets/setup-prompt.md` | A paste-ready prompt that drives the whole install through Claude Code, guided or fully autonomous. |

## The three parts

1. **Seat token.** The CLI picks auth as `ANTHROPIC_API_KEY` > `CLAUDE_CODE_OAUTH_TOKEN` > stored login. Strip the API key so it falls through to your subscription seat; for headless/servers, mint a long-lived token with `claude setup-token`.
2. **Free number.** Kapso's free plan gives a pre-verified sandbox number (no Meta business verification), ~2000 messages/month. You receive on your own normal WhatsApp.
3. **Triggers.** On-demand outbound, a scheduled daily digest, event-driven alerts (the seat decides if something is worth a heads-up), and two-way replies via an inbound webhook.

Read `SKILL.md` for the details, including the Meta 24-hour-window rule that every WhatsApp integration has to deal with.

## Quick start

**As a Claude Code skill**

```bash
git clone https://github.com/robinbril/openclaude ~/.claude/skills/openclaude
```

Then open `assets/setup-prompt.md`, set `MODE: guided` or `MODE: autonomous`, and
paste it into a Claude Code session. It locates the seat, copies the bridge,
fills the `.env`, starts a tunnel, registers the webhook, brings the bridge up,
sends a test WhatsApp, and wires autostart, verifying each step as it goes.

**By hand**

1. Copy `assets/seat-bridge.template.mjs` into your project as `seat-bridge.mjs`.
2. Create a `.env` next to it (see the header of the bridge for every variable).
3. Fill `buildContext()` with whatever your app should reason over.
4. Point a public tunnel (cloudflared, ngrok, tailscale funnel) at `/webhook`.
5. `node seat-bridge.mjs`, then register the inbound webhook and put the returned
   `secret_key` in `.env`.

## Safety

- The bot messages only an allowlisted number, never strangers.
- Never auto-send messages or emails to third parties. For email, create drafts
  only; a human reviews and sends.
- Every webhook is HMAC-verified against the raw request body.
- Secrets (`KAPSO_API_KEY`, `WEBHOOK_SECRET`, the seat token, any app passwords)
  live only in a gitignored `.env`, never in the repo.

## License

MIT
