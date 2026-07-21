/**
 * OpenClaude seat bridge (generic template).
 *
 * A tiny host-side Node process that gives an app or agent a WhatsApp presence
 * running entirely on a Claude Code SUBSCRIPTION SEAT (no API key, no metered
 * tokens). It:
 *   - shells out to the `claude` CLI for the intelligence (seat auth),
 *   - sends/receives WhatsApp through Kapso's HTTP API,
 *   - exposes /health, /chat, /notify, /webhook for your app + a tunnel.
 *
 * Copy this file, drop a `.env` next to it (see CONFIG below), fill the two
 * TODOs (buildContext + answerMessage), point a public tunnel at /webhook, and
 * run it:  node seat-bridge.template.mjs
 *
 * No required npm deps. Node 18+ (built-in fetch).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileP = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

// ── Minimal .env loader (no dotenv dependency) ──
const envFile = join(here, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
  }
}

// ── CONFIG (all from env / .env) ──
const PORT = Number(process.env.SEAT_PORT || 8771)
// Full path to the claude binary. On Windows usually:
//   %USERPROFILE%\.local\bin\claude.exe   On macOS/Linux: just `claude` on PATH.
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  join(process.env.HOME || process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe')
const MODEL = process.env.CLAUDE_MODEL || 'sonnet' // sonnet | opus | haiku
// Shared secret between your app and this bridge (so a LAN peer can't hit it).
const SEAT_KEY = process.env.SEAT_KEY || ''

// Kapso WhatsApp (kapso.ai). Free sandbox: pre-verified number, ~2000 msg/mo.
const KAPSO_API_KEY = process.env.KAPSO_API_KEY || ''
const KAPSO_PHONE_ID = process.env.KAPSO_PHONE_ID || '' // "Phone Number ID" from the sandbox page
const NOTIFY_TO = process.env.NOTIFY_TO || '' // your WhatsApp number, digits only, e.g. 316XXXXXXXX

// Proactive daily digest.
const NOTIFY_ENABLED = (process.env.NOTIFY_ENABLED || 'true').toLowerCase() !== 'false'
const NOTIFY_HOUR = Number(process.env.NOTIFY_HOUR || 9) // local hour, 0-23
const STATE_FILE = join(here, '.notify-state.json')

// Event-driven alerts poll cadence.
const ALERTS_ENABLED = (process.env.ALERTS_ENABLED || 'true').toLowerCase() !== 'false'
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 10)

// Inbound webhook (two-way). Set to the secret_key Kapso RETURNS at registration.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''

// Persona / instructions for the model. Edit freely.
const SYSTEM = `You are a helpful assistant that speaks to the user over WhatsApp and in-app chat.
Keep replies short and concrete. You are given the user's current data as context; reason from it, never invent numbers.`

// ── Seat call (the whole point: strip the API key, use the subscription seat) ──
async function callClaude(prompt, { model = MODEL, allowDir = null, maxTurns = 1 } = {}) {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY // force the seat, never the paid API
  const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--max-turns', String(maxTurns)]
  // For vision (reading an image), pass the folder + the Read tool, then
  // reference the file by name in the prompt. Do NOT pass --tools "".
  if (allowDir) args.push('--add-dir', allowDir, '--allowedTools', 'Read')
  const { stdout } = await execFileP(CLAUDE_BIN, args, {
    env,
    cwd: allowDir || tmpdir(), // tmpdir keeps a stray project CLAUDE.md from hijacking the persona
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  const envelope = JSON.parse(stdout) // { is_error, api_error_status, result }
  if (envelope.is_error) throw new Error(`claude ${envelope.api_error_status || ''}: ${envelope.result || 'error'}`)
  return envelope.result
}

// ── WhatsApp send via Kapso ──
async function sendWhatsApp(body, to = NOTIFY_TO) {
  if (!KAPSO_API_KEY || !KAPSO_PHONE_ID || !to) {
    throw new Error('Kapso not configured (set KAPSO_API_KEY, KAPSO_PHONE_ID, NOTIFY_TO in .env)')
  }
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${KAPSO_PHONE_ID}/messages`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': KAPSO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  })
  const txt = await r.text()
  // A 422 "outside the 24-hour window" here means the user has not messaged the
  // bot in the last 24h. Send the bot one message to reopen the window.
  if (!r.ok) throw new Error(`Kapso ${r.status}: ${txt.slice(0, 300)}`)
  return txt
}

// ── TODO #1: feed your app's live data to the model ──
// Return a compact text block: balances, recent items, whatever the assistant
// should reason over. Keep it small; this string is prepended to every prompt.
// Cache briefly so a burst of messages doesn't hammer your data source.
let _ctx = { ts: 0, text: '' }
async function buildContext() {
  if (Date.now() - _ctx.ts < 30_000 && _ctx.text) return _ctx.text
  // Example: const data = await (await fetch(`${API}/summary`, { headers })).json()
  const text = '(no data source wired yet, fill buildContext())'
  _ctx = { ts: Date.now(), text }
  return _ctx.text
}

// ── TODO #2 (optional): widen this if you want the assistant to take actions ──
// The simple version just answers. To let it change things, have the model emit
// a fenced block (e.g. ```action [json]```), parse it here, run a WHITELIST of
// reversible operations against your API, and append a short result summary.
// Never allow deletes, money movement, or auto-sending email from here.
async function answerMessage(message, history = [], whatsapp = false) {
  const ctx = await buildContext()
  const convo = (history || [])
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')
  const fmt = whatsapp ? '\n\n(This reply goes to WhatsApp: plain text, no markdown tables, keep it short.)' : ''
  const prompt = `${SYSTEM}\n\n=== DATA ===\n${ctx}\n\n=== CONVERSATION ===\n${convo || '(start)'}\n\n=== NEW MESSAGE ===\n${message}${fmt}\n\nReply:`
  return (await callClaude(prompt, { whatsapp })).trim()
}

// ── Trigger 2: scheduled daily digest ──
function lastNotifyDate() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')).date
  } catch {
    return null
  }
}
function setNotifyDate(d) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ date: d }))
  } catch {
    /* ignore */
  }
}
async function composeDigest() {
  const ctx = await buildContext()
  const prompt = `${SYSTEM}\n\n=== DATA ===\n${ctx}\n\nWrite a short WhatsApp check-in (max 6 lines, plain text, no markdown). Speak to the user directly.`
  return (await callClaude(prompt)).trim()
}
async function maybeNotify(force = false) {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  if (!force) {
    if (!NOTIFY_ENABLED || !KAPSO_API_KEY) return null
    if (now.getHours() < NOTIFY_HOUR) return null
    if (lastNotifyDate() === today) return null
  }
  const msg = await composeDigest()
  await sendWhatsApp(msg)
  setNotifyDate(today)
  return msg
}

// ── Trigger 3: event-driven (poll your data, let the seat decide) ──
// Sketch: fetch recent items, diff against what you've already seen, ask the
// seat "worth a heads-up? reply with a short message or exactly NONE", send
// only if not NONE. Persist seen-ids in a small file. Left as a stub here since
// it's entirely shaped by your data source.
async function checkNewItems() {
  if (!ALERTS_ENABLED) return null
  // const fresh = await diffYourDataSource()
  // if (!fresh.length) return null
  // let out = (await callClaude(`${SYSTEM}\n...\nReply with a short message or exactly NONE.`)).trim()
  // if (/^none\.?$/i.test(out)) return null
  // await sendWhatsApp(out)
  return null
}

// ── Trigger 4: inbound webhook -> reply (also keeps the 24h window open) ──
async function handleInbound(from, text) {
  try {
    const reply = await answerMessage(text, [], true)
    if (reply) await sendWhatsApp(reply, from)
  } catch (e) {
    console.error('webhook reply:', e.message)
  }
}

// ── HTTP server ──
function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Seat-Key',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  })
  res.end(JSON.stringify(obj))
}
const authed = (req) => !SEAT_KEY || req.headers['x-seat-key'] === SEAT_KEY
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => resolve(raw))
  })
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {})
  if (req.url === '/health') return send(res, 200, { ok: true })

  // Trigger 1 source: in-app chat.
  if (req.method === 'POST' && req.url === '/chat') {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' })
    try {
      const { message, history = [] } = JSON.parse((await readBody(req)) || '{}')
      if (!message || typeof message !== 'string') return send(res, 400, { error: 'message required' })
      send(res, 200, { answer: await answerMessage(message, history, false) })
    } catch (e) {
      send(res, 500, { error: String(e.message || e) })
    }
    return
  }

  // Trigger 1 (on-demand outbound): compose + send the digest now.
  if (req.method === 'POST' && req.url === '/notify') {
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' })
    try {
      send(res, 200, { sent: true, message: await maybeNotify(true) })
    } catch (e) {
      send(res, 500, { error: String(e.message || e) })
    }
    return
  }

  // Trigger 4: inbound WhatsApp webhook from Kapso (two-way).
  if (req.url === '/webhook') {
    if (req.method === 'GET') return send(res, 200, { ok: true }) // URL reachability check
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' })
    const raw = await readBody(req)
    if (WEBHOOK_SECRET) {
      // HMAC-SHA256 of the RAW body. Verify against raw bytes, never re-serialized JSON.
      const sig = String(req.headers['x-webhook-signature'] || '').replace(/^sha256=/i, '')
      const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex')
      const ok =
        sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      if (!ok) {
        console.error('webhook: bad signature')
        return send(res, 401, { error: 'bad signature' })
      }
    }
    send(res, 200, { ok: true }) // ack fast, then process async (the seat call can take ~20s)
    try {
      const body = JSON.parse(raw || '{}')
      const data = body.data || body
      const msg = data.message || (data.data && data.data.message)
      if (!msg || msg.type !== 'text') return
      if (msg.kapso && msg.kapso.direction && msg.kapso.direction !== 'inbound') return
      const from = msg.from // payload v2: sender at message.from
      const text = msg.text && msg.text.body // text at message.text.body
      if (!from || !text) return
      // Only answer the allowlisted number, so the bot never replies to strangers.
      if (NOTIFY_TO && String(from).replace(/\D/g, '') !== String(NOTIFY_TO).replace(/\D/g, '')) return
      handleInbound(from, text)
    } catch (e) {
      console.error('webhook parse:', e.message)
    }
    return
  }

  send(res, 404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  const notify = NOTIFY_ENABLED && KAPSO_API_KEY ? `daily@${NOTIFY_HOUR}:00` : 'off'
  console.log(`openclaude bridge on :${PORT}  seatKey=${SEAT_KEY ? 'on' : 'off'}  notify=${notify}`)
})

// Daily digest: check every 15 min, send once per day at/after NOTIFY_HOUR.
setInterval(() => maybeNotify().catch((e) => console.error('notify:', e.message)), 15 * 60 * 1000)
// Event poll: let the seat decide whether new items warrant a heads-up.
setInterval(() => checkNewItems().catch((e) => console.error('alerts:', e.message)), POLL_MINUTES * 60 * 1000)

// One-shot helper registration of the inbound webhook (run once, then remove):
//   node -e "fetch('https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/'+process.env.KAPSO_PHONE_ID+'/webhooks',{method:'POST',headers:{'X-API-Key':process.env.KAPSO_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({whatsapp_webhook:{kind:'kapso',url:'https://YOUR_PUBLIC_URL/webhook',events:['whatsapp.message.received'],secret_key:'pick-anything'}})}).then(r=>r.text()).then(console.log)"
// The RESPONSE contains the secret_key to put in WEBHOOK_SECRET.
