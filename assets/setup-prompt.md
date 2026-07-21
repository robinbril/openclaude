# OpenClaude setup prompt (paste-ready)

Paste the block below into a fresh Claude Code session in the project (or folder)
where you want the WhatsApp bridge to live. Set `MODE` on the first line:

- `MODE: guided` walks you through every step, pausing for confirmation and
  explaining each external action before you take it.
- `MODE: autonomous` does everything it can without asking, and pauses ONLY at
  the handful of steps a human has to do (creating the Kapso account and
  scanning the sandbox activation code), then continues on its own.

The skill it relies on is `openclaude` (read its SKILL.md and
`assets/seat-bridge.template.mjs` first). Everything below is the prompt.

---

MODE: autonomous

You are setting up "OpenClaude": a WhatsApp presence for this app/agent that runs
on my Claude Code SUBSCRIPTION SEAT (no API key, no metered tokens). Use the
`openclaude` skill as your reference: read its SKILL.md and the bridge template
at `assets/seat-bridge.template.mjs` before doing anything.

## Your job

Stand up the full pipeline end to end and prove it works:

  WhatsApp <-> Kapso <-> public tunnel <-> host bridge -> claude CLI (seat)

Drive it according to MODE above. In `guided` mode, confirm with me before each
step and explain it. In `autonomous` mode, do every step you can yourself,
verify each one, and stop ONLY for the human-only steps (clearly flagged with
[HUMAN] below). When you hit a [HUMAN] step, print exactly what I need to do in a
short numbered list, wait for me to say "done" plus paste whatever value the step
produces, then continue without further prompting.

## Steps

1. **Locate the seat.**
   - Find the claude binary (`which claude`, or on Windows
     `%USERPROFILE%\.local\bin\claude.exe`). Record it as `CLAUDE_BIN`.
   - Decide the auth path: if this bridge runs on THIS logged-in host, stripping
     `ANTHROPIC_API_KEY` from the child env is enough (the template already does
     this). If it will run headless / on another machine / under autostart, run
     `claude setup-token` once and capture the `sk-ant-oat01-...` token for
     `CLAUDE_CODE_OAUTH_TOKEN`. [HUMAN] `claude setup-token` opens a browser and
     needs my login: flag it, I will run it and paste the token.
   - Sanity-check the seat: call `claude -p "say OK" --output-format json
     --model sonnet --max-turns 1` with `ANTHROPIC_API_KEY` unset and confirm
     `is_error` is false.

2. **Kapso account + free number.** [HUMAN]
   - Tell me to sign up at kapso.ai (free plan: sandbox number, 1 number,
     ~2000 msg/mo) and to:
     a. WhatsApp -> Sandbox -> Add Test Number -> enter my WhatsApp number ->
        get a 6-character code -> open WhatsApp to the sandbox number and send
        that code (activates the session). Then send one more normal message so
        the 24h freeform window is open.
     b. Project Settings -> API Keys -> Create. Copy the key.
     c. WhatsApp -> Sandbox -> copy the "Phone Number ID".
   - Wait for me to paste: my WhatsApp number (digits only, international),
     the API key, and the phone number id.

3. **Copy the bridge.**
   - Copy `assets/seat-bridge.template.mjs` from the openclaude skill into this
     project as `seat-bridge.mjs` (or a `bridge/` subfolder). Do not edit the
     template in the skill folder.
   - Wire TODO #1 `buildContext()` to this app's real data source (DB query,
     API call, file read, whatever is here). If there is no obvious data source,
     leave the stub and note it. Wire TODO #2 only if I ask for actions; default
     to answer-only.

4. **Create the `.env`** next to the bridge with the collected values:
   `CLAUDE_BIN`, `CLAUDE_MODEL` (default sonnet), `SEAT_KEY` (generate a random
   one), `KAPSO_API_KEY`, `KAPSO_PHONE_ID`, `NOTIFY_TO` (my number),
   `NOTIFY_HOUR`, and `CLAUDE_CODE_OAUTH_TOKEN` if step 1 produced one.
   Add `.env`, `.notify-state.json`, `.last-digest` to `.gitignore`. Never put
   any secret in the repo, in a commit, or in your chat output.

5. **Public tunnel.**
   - Start a tunnel to the bridge port (default 8771): prefer `cloudflared
     tunnel --url http://localhost:8771`, else ngrok or a tailscale funnel.
     [HUMAN] if the tunnel tool needs a login or install I cannot do silently,
     flag it. Capture the public https URL as `PUBLIC_URL`.

6. **Start the bridge and self-test.**
   - Run `node seat-bridge.mjs` (background it). Confirm `GET PUBLIC_URL/health`
     returns `{ok:true}`.
   - Send a test message: `POST /notify` with the `X-Seat-Key` header. Confirm I
     receive a WhatsApp from the sandbox number. If Kapso returns a 422
     "outside the 24-hour window", tell me to message the bot once, then retry.

7. **Register the inbound webhook (two-way).**
   - POST to
     `https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/<PHONE_ID>/webhooks`
     with `kind: kapso`, `url: PUBLIC_URL/webhook`,
     `events: ['whatsapp.message.received']`. The RESPONSE returns a
     `secret_key`: write THAT exact value into `.env` as `WEBHOOK_SECRET` and
     restart the bridge (the verifier must use the returned key, not one you
     picked).
   - Test: I send a WhatsApp to the bot, confirm it replies. Confirm the bridge
     ignores any number that is not my allowlisted `NOTIFY_TO`.

8. **Keep it running (autostart).**
   - Windows: write a hidden launcher to the Startup folder (`shell:startup`):
     a `.cmd` that `cd`s to the bridge and runs `node seat-bridge.mjs`, plus a
     `.vbs` that launches the `.cmd` with window style 0 so it starts invisibly
     at logon. Same for the tunnel.
   - Linux/VPS: a systemd unit or `pm2 start seat-bridge.mjs`. The seat token
     from step 1 is what lets it run unattended.

9. **Report.** Summarize: bridge URL, which triggers are live (on-demand,
   daily digest at NOTIFY_HOUR, event poll, two-way), what `buildContext()` is
   reading, and the autostart method. List every file you created. Do NOT print
   any secret value.

## Hard rules (do not break, even in autonomous mode)

- **Never auto-send messages or emails to third parties.** The bot messages ONLY
  my allowlisted number. For email integrations: create drafts only, I send.
- **Secrets live only in the gitignored `.env`.** Never in the repo, a commit, a
  log, or your chat output. If you must echo a value back, mask it.
- **HMAC-verify every webhook** against the raw request body; reply only to the
  allowlisted number.
- Pause at every [HUMAN] step. Do not fabricate Kapso credentials, a phone id,
  or a token to "keep going": wait for me to paste the real value.
- Verify each step against the running artifact (health check, real WhatsApp
  received, real reply) before calling it done. No "should work" claims.
