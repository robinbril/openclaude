---
name: openclaude
description: Give any app or agent a free WhatsApp presence that runs on your Claude Code subscription seat (no API key, no per-token cost). Covers three things, grabbing the team seat token for headless use, creating a free Kapso WhatsApp sandbox number, and wiring triggers (proactive alerts, scheduled digests, two-way replies) through a small host bridge. Use when the user wants to connect an app, agent, notifications, or a coach/chatbot to WhatsApp via their Claude seat, set up Kapso WhatsApp, run the Claude CLI headless on a subscription seat, or build seat-driven messaging.
---

# OpenClaude: a free WhatsApp agent on your Claude seat

Wire WhatsApp to an AI that runs on your Claude Code **subscription seat** (no API key, no metered tokens). The model writes the messages, a tiny host "bridge" does the I/O, and Kapso provides a free WhatsApp number. Three parts: the seat token, the free number, and the triggers that make it talk.

## Architecture (why a host bridge)

The `claude` CLI seat lives on a host machine (it uses your stored login). A backend in Docker or on another box usually can't reach that CLI. So run a small Node process on the host, the **bridge**, that:

- shells out to `claude -p` for the intelligence (seat auth, no API key),
- talks to Kapso's HTTP API to send/receive WhatsApp,
- exposes a few endpoints your app or a tunnel can reach.

```
WhatsApp <-> Kapso <-> (public tunnel) <-> bridge (host) -> claude CLI (seat)
                                                  ^-- your app/data source
```

A ready-to-adapt bridge is in `assets/seat-bridge.template.mjs`. Zero npm deps except the optional ones you add (e.g. `imapflow` for Gmail). Read the three parts below, then copy the template and fill the two TODOs (`buildContext` and your data source).

## Part 1, grab the team seat token

The CLI picks auth in this order: `ANTHROPIC_API_KEY` (paid API) > `CLAUDE_CODE_OAUTH_TOKEN` (seat via token) > stored login in `~/.claude/.credentials.json` (seat via subscription). So the trick is always: **strip the API key** so it falls through to the seat.

**On the host where you're logged in** (simplest): do nothing special, just remove the key from the child env.

```js
const env = { ...process.env }
delete env.ANTHROPIC_API_KEY          // force the subscription seat, never the paid API
```

**Headless / another machine / VPS** (no interactive login, or cron): mint a long-lived seat token once and set it as an env var.

```bash
claude setup-token        # interactive, opens a browser, prints a token (valid ~1 year)
# then in the bridge env / .env:
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

With `CLAUDE_CODE_OAUTH_TOKEN` set (and `ANTHROPIC_API_KEY` unset), the CLI uses the seat without needing the credentials file. This is how you run the seat on a server.

**Invoke it** (one-shot, machine-readable):

```js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)

async function callClaude(prompt) {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  const { stdout } = await execFileP(
    process.env.CLAUDE_BIN || 'claude',                 // full path to claude.exe on Windows
    ['-p', prompt, '--output-format', 'json', '--model', 'sonnet', '--max-turns', '1'],
    { env, cwd: require('os').tmpdir(), maxBuffer: 32 * 1024 * 1024, windowsHide: true },
  )
  const envelope = JSON.parse(stdout)            // { is_error, api_error_status, result }
  if (envelope.is_error) throw new Error(`claude ${envelope.api_error_status || ''}: ${envelope.result}`)
  return envelope.result
}
```

Notes:
- `cwd: tmpdir()` keeps a stray project `CLAUDE.md` from hijacking the persona.
- For **vision** (read an image/receipt) add `--allowedTools Read --add-dir <folder>` (do NOT pass `--tools ""`) and reference the file by name; the seat reads it multimodally.
- Find the binary: `which claude` / on Windows it's usually `%USERPROFILE%\.local\bin\claude.exe`.
- Locked to one model? Pass `--model sonnet|opus|haiku` per call; the seat respects it.

## Part 2, a free WhatsApp number (Kapso sandbox)

Sign up at kapso.ai. The **free plan** includes a sandbox number (pre-verified, no Meta business verification), 1 connected number, ~2000 messages/month. You only ever **receive** on your own normal WhatsApp; the sandbox number is the sender, so your personal number stays a normal number.

1. **Sandbox session** (so the bot may message you): dashboard, WhatsApp -> Sandbox -> Add Test Number -> enter your WhatsApp number -> you get a 6-character code -> open WhatsApp to the sandbox number and send that code -> session active. (The activation code does NOT open the 24h freeform window, see below; send one more normal message to do that.)
2. **API key**: Project Settings -> API Keys -> Create. Header is `X-API-Key`.
3. **phone_number_id**: WhatsApp -> Sandbox shows "Telefoonnummer-ID / Phone Number ID". That goes in the send URL.

**Send a text:**

```js
await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${PHONE_ID}/messages`, {
  method: 'POST',
  headers: { 'X-API-Key': KAPSO_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ messaging_product: 'whatsapp', to: YOUR_NUMBER, type: 'text', text: { body } }),
})
// YOUR_NUMBER = digits only, international, e.g. 316XXXXXXXX
```

## Part 3, triggers (make it talk)

Four ways to make it speak, mix as needed (all in the template):

1. **On-demand outbound** - an endpoint (`POST /notify`) that composes a message via the seat and sends it. Good for "send me a summary now".
2. **Scheduled digest** - `setInterval` checks every 15 min; once per day past `NOTIFY_HOUR` it composes and sends. Track the last-sent date in a small file so it fires once.
3. **Event-driven** - poll your data source (every N min) for new items; pass the new items to the seat with "is this worth a heads-up? reply with a short message or exactly NONE"; send only if not NONE. The seat decides.
4. **Two-way (inbound webhook)** - the most useful, and it keeps the 24h window alive (see below). Register a webhook so Kapso POSTs inbound messages to your bridge; the bridge replies via the seat.

**Register the inbound webhook** (you have the API key + phone id):

```js
await fetch(`https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/${PHONE_ID}/webhooks`, {
  method: 'POST',
  headers: { 'X-API-Key': KAPSO_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ whatsapp_webhook: {
    kind: 'kapso',
    url: 'https://YOUR_PUBLIC_URL/webhook',          // must be publicly reachable
    events: ['whatsapp.message.received'],
    secret_key: YOUR_WEBHOOK_SECRET,
  }}),
})
```

Critical gotchas for the webhook:
- The registration **response returns a `secret_key`**, your verifier MUST use that exact value (Kapso decides it). Set `WEBHOOK_SECRET` to the returned value, not what you sent.
- Signature: `X-Webhook-Signature` = HMAC-SHA256 of the **raw request body** with the secret. Verify against the raw bytes, never a re-serialized JSON.
- Payload v2: sender at `message.from`, text at `message.text.body`.
- **Public reachability**: expose the bridge with a tunnel, tailscale funnel, cloudflared, or ngrok. Localhost won't reach Kapso.
- Ack fast (return 200), then process + reply async, so the webhook doesn't time out on the ~20s seat call.
- Restrict replies to your own number so the bot doesn't answer strangers.

## The 24-hour window (read this)

Meta rule: you can only send **freeform** text within 24h of the user's last inbound message. Outside that you need an **approved template**, and the Kapso **sandbox has no templates**. Consequences:

- A test send works right after you message the bot.
- Two-way chat keeps the window open automatically while you use it (every inbound resets the 24h clock). This is the "keep it alive smartly" trick.
- For guaranteed unprompted daily alerts even after days of silence, you need a **production number + one approved template** (not the sandbox).

## Keep it running

The bridge must stay up. Windows (no admin needed): drop a hidden launcher in the Startup folder (`shell:startup`). A `.vbs` that runs a `.cmd` with window style 0 starts it invisibly at logon. Linux/VPS: systemd unit or `pm2`. The seat token (Part 1) is what lets it run unattended.

## Safety (non-negotiable)

- **Never auto-send** outbound messages/emails to third parties. For email, create **drafts only** (the user reviews and sends). Cancellation/complaint mails: draft, never send.
- HMAC-verify every webhook; reply only to allowlisted numbers.
- Secrets (`KAPSO_API_KEY`, `WEBHOOK_SECRET`, seat token, any app passwords) live in a **gitignored** `.env`, never in the repo.
- Shared secret (`SEAT_KEY`) between your app and the bridge if the bridge binds `0.0.0.0`, so the LAN can't hit it.

## Reference implementation

`assets/seat-bridge.template.mjs` is a complete, generic bridge: `/health`, `/chat`, `/notify`, `/webhook`, the daily scheduler, and the event poll, with HMAC verification and the seat call. Copy it, set the `.env`, fill `buildContext()` with whatever your app exposes, and point a tunnel at `/webhook`. It has no required npm deps.

## One-shot setup (let an agent do it)

`assets/setup-prompt.md` is a paste-ready prompt that drives the whole install through Claude Code. Set `MODE: guided` for a step-by-step walkthrough that pauses and explains, or `MODE: autonomous` to have the agent do everything it can on its own and stop only at the irreducible human steps (creating the Kapso account, scanning the sandbox activation code, the browser login for `claude setup-token`). It locates the seat, copies the bridge, fills the `.env`, starts a tunnel, registers the webhook, brings the bridge up, sends a test WhatsApp, and wires autostart, verifying each step against the running artifact. The same hard safety rules apply (allowlist only, secrets in `.env`, drafts-not-sends for email).
