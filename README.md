# Local-Machine-Spirit-UI

A chat UI for your local AI agent ([Hermes Agent](https://github.com/NousResearch/hermes-agent), or anything else that speaks the OpenAI chat API), styled as a grimdark cogitator terminal: brass bezel, phosphor CRT, scanlines, litanies while the machine spirit thinks.

It installs on your phone as a **Progressive Web App**, so you can talk to Hermes from anywhere on your tailnet without setting up Telegram, SMS, or Discord.

> Unofficial fan-styled project. Not affiliated with or endorsed by Games Workshop. No official artwork or logos are used.

## What it does

- **Streams replies** from Hermes token by token, with Markdown, tables, and code blocks (each code block has a copy button).
- **Shows tool use as "rites"**: when Hermes runs a terminal command, searches the web, and so on, a `[ INVOKING ]` line appears and changes to `[ COMPLETE ]` when it finishes (from Hermes' `hermes.tool.progress` events).
- **Approval prompts ("Sanction required")**: when Hermes wants to run a dangerous command, it pauses for your approval. You can choose *Grant once*, *Grant for this communion*, *Grant eternally* or *Forbid*. The UI answers through Hermes' `/v1/runs/{id}/approval` endpoint.
- **Reasoning**: when the model returns reasoning, it appears in a collapsible "Deliberations of the spirit" panel. You can turn this off in settings.
- **Cease button** stops a run in progress.
- **Picture attachments**: images are downscaled on the phone and sent as inline images, which Hermes supports.
- **Conversation archive** saved on the device. Each conversation is tied to its own Hermes session (`X-Hermes-Session-Id`), so Hermes keeps the full history on its side, including tool calls.
- **Link light**: a status indicator shows whether Hermes is reachable.
- **Four phosphor colours** (green, amber, crimson, pale blue), an optional boot sequence, and CRT effects you can turn off.
- **Optional "Ritual speech"** setting: adds a system prompt so Hermes answers in character as a machine spirit while keeping the content accurate.
- **Installable PWA**: works full-screen from the home screen, the app shell works offline, and you get a notification when a reply or approval request arrives while the app is in the background.

## Architecture

```
 Phone (PWA) ──HTTPS over Tailscale──▶ Raspberry Pi
                                        ├─ tailscale serve :443 → 127.0.0.1:8080
                                        ├─ Cogitator (node server.js) :8080
                                        │     serves the PWA + relays /api/hermes/* ──┐
                                        └─ Hermes gateway API server 127.0.0.1:8642 ◀─┘
                                               │
                                               └──▶ Ollama on DGX Spark  http://<spark>:11434/v1
```

The small Node server keeps the Hermes API key on the Pi, so the key never reaches your phone. It also means Hermes needs no CORS setup and can stay bound to localhost. The relay only forwards the few endpoints the UI uses.

**No dependencies:** you need Node.js 18 or newer and nothing else. There is no `npm install` and no build step.

## Setup on the Raspberry Pi

### 1. Hermes: turn on the API server

Add this to `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random string>     # e.g. openssl rand -hex 32
# Keep the default host 127.0.0.1. Only the cogitator talks to it.
```

To use the Ollama server on your DGX Spark as Hermes' model, run `hermes model`, choose **Custom endpoint**, and enter `http://<spark-tailnet-name>:11434/v1` (no API key). Hermes needs at least a 64k context window, so run Ollama with `OLLAMA_CONTEXT_LENGTH=64000` or higher.

Start the gateway with `hermes gateway`, or install it as a service with `hermes gateway install`. Then check it:

```bash
curl http://127.0.0.1:8642/health        # → {"status": "ok"}
```

### 2. Cogitator

```bash
git clone https://github.com/dsmith111/Local-Machine-Spirit-UI.git
cd Local-Machine-Spirit-UI
cp .env.example .env
nano .env        # set HERMES_API_KEY (same value as API_SERVER_KEY) and COGITATOR_ACCESS_CODE
npm start
```

To run it at boot, edit the `User` and `WorkingDirectory` lines in `deploy/machine-spirit-ui.service` if needed, then:

```bash
sudo cp deploy/machine-spirit-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now machine-spirit-ui
```

### 3. Expose it on your tailnet with HTTPS

PWAs (service worker, install to home screen) require HTTPS. Tailscale can provide a real certificate:

```bash
sudo tailscale serve --bg 8080
tailscale serve status       # shows https://<pi-name>.<tailnet>.ts.net
```

HTTPS certificates must be enabled for your tailnet in the Tailscale admin console under DNS → HTTPS Certificates.

### 4. Install on your phone

Open `https://<pi-name>.<tailnet>.ts.net` on your phone.

- **iOS (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu → **Install app**.

If you set an access cipher, enter it once in the Configuration Rites (gear icon). It is stored on the device.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Address the cogitator listens on (Tailscale serve connects to localhost) |
| `PORT` | `8080` | Port the cogitator listens on |
| `HERMES_URL` | `http://127.0.0.1:8642` | Hermes API server address |
| `HERMES_API_KEY` | — | Must match Hermes' `API_SERVER_KEY` |
| `HERMES_MODEL` | `hermes-agent` | Model name sent to Hermes. Use your profile name if you run a Hermes profile |
| `COGITATOR_ACCESS_CODE` | — | Optional passphrase the phone must send. Recommended, because Hermes can run shell commands |

Real environment variables take precedence over the `.env` file.

**Other backends:** `HERMES_URL` can point at any OpenAI-compatible `/v1/chat/completions` server, such as Ollama directly (`http://<spark>:11434`) or OpenClaw's OpenAI endpoint. Plain chat works with any of them. Tool rites, sanctions and sessions only light up with Hermes.

## Try it without Hermes

A mock server sends the same events Hermes does, so you can test the UI without the Pi:

```bash
npm run mock                                  # fake Hermes on :8642
HERMES_API_KEY=mock npm start                 # in another terminal → http://localhost:8080
```

Put the word "sanction" in a message to trigger an approval prompt.

## Security notes

- Hermes can run terminal commands on the Pi. Keep the cogitator on your tailnet only: use `tailscale serve`, **not** `tailscale funnel`, and set `COGITATOR_ACCESS_CODE`.
- The relay only allows a small set of endpoints through: health, models, chat completions, and stop/approval for runs. It adds the bearer token on the server side.
- Conversation history in the app is stored in the browser's `localStorage` on each device. Use **Purge Archives** in settings to clear it.

## Project layout

```
server.js                 zero-dependency static server + Hermes relay
public/                   the PWA (index.html, styles.css, app.js, markdown.js, sw.js, manifest, icons)
scripts/mock-hermes.js    fake Hermes for local testing
scripts/make-icons.js     regenerates PNG icons from icons/icon.svg (needs Playwright)
deploy/                   systemd unit
```
