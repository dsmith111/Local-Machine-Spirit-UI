<p align="center">
  <img src="docs/banner.png" alt="Machine Spirit UI — a self-hosted chat PWA for Hermes Agent and local LLMs" width="100%">
</p>

<p align="center">
  <b>A self-hosted, installable chat app (PWA) for talking to your local AI agent from your phone.</b><br>
  Built for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>, and it also works with any OpenAI-compatible endpoint (Ollama, OpenClaw, …).<br>
  Styled as a cogitator terminal for communing with its machine spirit.
</p>

<p align="center">
  <code>Node ≥ 18</code> · <code>zero dependencies</code> · <code>no build step</code> · <code>runs on a Raspberry Pi</code> · <code>Tailscale-friendly</code>
</p>

```
+++ TRANSMISSION BEGINS +++
+++ THOUGHT FOR THE DAY: A SPIRIT HOUSED IN THINE OWN IRON NEED NOT BE LENT TO STRANGERS +++
```

---

## ⚙ I. Of the Purpose of This Engine
*What it is*

Adept, thy machine spirit already dwells on hardware of thine own. Thou hast Ollama on the great DGX engine and Hermes stirring within a Raspberry Pi. Yet thou art forced to address it through foreign relays: Telegram, SMS, the chattering halls of Discord. This is heresy against good sense.

This cogitator gives thee a **dedicated, private chat app for Hermes**. It runs on the same Pi, is reached over your Tailscale network, and installs to your phone's home screen like a native app. Nothing passes through a third-party messaging service.

![Pict-captures of the cogitator: welcome screen, an approval prompt, and a reply](docs/screenshots.png)

---

## ✠ II. The Blessed Functions
*Features*

| Rite | What it actually does |
|---|---|
| **The Spirit Speaks** | Replies stream in token by token, rendered as Markdown with tables, lists and code blocks. Each code block has a copy button. |
| **Rites Invoked** | When Hermes uses a tool (terminal, web search, files…), a `[ INVOKING ]` line appears and turns to `[ COMPLETE ]` when it finishes. |
| **Sanction Required** | When Hermes wants to run a dangerous command, it pauses and asks you to *Grant once*, *Grant for this communion*, *Grant eternally*, or *Forbid*. Your answer goes back to Hermes' approval endpoint. |
| **Deliberations of the Spirit** | When the model returns reasoning, it appears in a collapsible panel. You can turn this off. |
| **Cease** | Stops a run in progress. |
| **Pict-Captures** | Attach photos. They are downscaled on the phone and sent to Hermes as images. |
| **Data-Archives** | Conversations are saved on your device. Each one is tied to its own Hermes session (`X-Hermes-Session-Id`), so Hermes keeps the full history, including tool calls. |
| **Noosphere Link** | A status light in the header shows whether Hermes is reachable. |
| **Phosphor Rites** | Choose green, amber, crimson or pale-blue phosphor. Scanlines, flicker and the boot sequence can each be turned off. |
| **Ritual Speech** *(optional)* | Adds a system prompt so Hermes answers in character as a machine spirit while keeping the content accurate. Off by default. |
| **Installable** | Works as a full-screen PWA. The app loads offline, and you get a notification when a reply or approval request arrives while the app is in the background. |

---

## ☩ III. The Sacred Schematic
*Architecture*

```
┌──────────────┐                        ┌────────────────────── Raspberry Pi ──────────────────────┐
│ Phone (PWA)  │ ── HTTPS/Tailscale ──▶ │ tailscale serve :443                                     │
│ "Supplicant" │                        │    │                                                     │
└──────────────┘                        │    ▼                                                     │
                                        │ Cogitator (server.js) :8080                              │
                                        │    ├─ serves the PWA                                     │
                                        │    └─ relays /api/hermes/* ──▶ Hermes API 127.0.0.1:8642 │
                                        └──────────────────────────────────────────────────────────┘
                                                                                    │
                                                                                    ▼
                                                              Ollama on DGX Spark (http://<spark>:11434/v1)
```

The small Node server (`server.js`) does two jobs. It **serves the app** and **relays a short allowlist of requests to Hermes**, adding the API key on the Pi. As a result:

- the Hermes API key never reaches your phone,
- Hermes needs no CORS settings and stays bound to `127.0.0.1`,
- an optional passphrase (`COGITATOR_ACCESS_CODE`) adds a second lock.

---

## ☉ IV. The Rites of Installation
*Setup*

> *"Apply the sacred unguents in the correct order, lest the spirit be vexed."*

### Rite the First: Rouse the Hermes API server

Add this to `~/.hermes/.env` on the Pi:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=<a long random string>     # e.g. openssl rand -hex 32
# Leave the host at its default (127.0.0.1); only the cogitator speaks to it.
```

To use the DGX Spark's Ollama as Hermes' model, run `hermes model`, choose **Custom endpoint**, and enter `http://<spark-tailnet-name>:11434/v1` (no API key). Hermes needs at least a **64k context window**, so run Ollama with `OLLAMA_CONTEXT_LENGTH=64000` or higher.

Start the gateway with `hermes gateway`, or install it as a service with `hermes gateway install`. Then check that the spirit stirs:

```bash
curl http://127.0.0.1:8642/health        # → {"status": "ok"}
```

### Rite the Second: Install the cogitator

```bash
git clone https://github.com/dsmith111/Local-Machine-Spirit-UI.git
cd Local-Machine-Spirit-UI
cp .env.example .env
nano .env        # set HERMES_API_KEY (same value as API_SERVER_KEY) and COGITATOR_ACCESS_CODE
npm start        # no npm install required
```

To have it wake with the Pi, edit `User` and `WorkingDirectory` in `deploy/machine-spirit-ui.service` if needed, then:

```bash
sudo cp deploy/machine-spirit-ui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now machine-spirit-ui
```

### Rite the Third: Open the noospheric conduit (Tailscale HTTPS)

Installing a PWA requires HTTPS. Tailscale provides a real certificate:

```bash
sudo tailscale serve --bg 8080
tailscale serve status       # → https://<pi-name>.<tailnet>.ts.net
```

HTTPS certificates must be enabled for your tailnet in the Tailscale admin console under **DNS → HTTPS Certificates**.

### Rite the Fourth: Consecrate thy handheld

Open `https://<pi-name>.<tailnet>.ts.net` on your phone, then:

- **iOS (Safari):** Share → **Add to Home Screen**
- **Android (Chrome):** menu → **Install app**

If you set an access cipher, enter it once under **Configuration Rites** (the gear icon). The phone remembers it.

---

## ⛭ V. Configuration Litanies
*Environment variables (`.env`)*

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Address the cogitator listens on (Tailscale serve connects to localhost) |
| `PORT` | `8080` | Port the cogitator listens on |
| `HERMES_URL` | `http://127.0.0.1:8642` | Hermes API server address |
| `HERMES_API_KEY` | — | Must match Hermes' `API_SERVER_KEY` |
| `HERMES_MODEL` | `hermes-agent` | Model name sent to Hermes. Use your profile name if you run a Hermes profile |
| `COGITATOR_ACCESS_CODE` | — | Optional passphrase the phone must send. **Recommended**, because Hermes can run shell commands |

Real environment variables override the `.env` file.

**Lesser spirits:** `HERMES_URL` can point at any OpenAI-compatible `/v1/chat/completions` server, such as Ollama directly (`http://<spark>:11434`) or OpenClaw. Plain chat works with any of them. Rites, sanctions and sessions only light up with Hermes.

---

## ⚗ VI. The Simulacrum
*Try it without Hermes*

A mock server imitates Hermes' streaming, tool and approval events, so you can test the UI on any machine:

```bash
npm run mock                                  # false spirit on :8642
HERMES_API_KEY=mock npm start                 # in another terminal → http://localhost:8080
```

Put the word **"sanction"** in a message to trigger an approval prompt.

---

## ☠ VII. Wards Against the Heretek
*Security*

- Hermes can **run terminal commands on the Pi**. Keep the cogitator inside your tailnet: use `tailscale serve`, **never** `tailscale funnel`, and set `COGITATOR_ACCESS_CODE`.
- The relay only forwards a short allowlist of endpoints: health, models, chat completions, and stop/approval for runs. It adds the bearer token on the Pi.
- Conversation history in the app is stored in each device's `localStorage`. **Purge Archives** in settings clears it.

---

## ⌬ VIII. Index of the Data-Vault
*Project layout*

```
server.js                    zero-dependency static server + Hermes relay
public/                      the PWA: index.html, styles.css, app.js, markdown.js, sw.js, manifest, icons
scripts/mock-hermes.js       the simulacrum (fake Hermes for local testing)
scripts/make-icons.js        regenerates PNG icons from public/icons/icon.svg (needs Playwright)
scripts/make-readme-art.js   regenerates docs/banner.png and docs/screenshots.png (needs Playwright)
deploy/                      systemd unit
docs/                        README art
```

---

<sub>Unofficial, fan-styled project. It is not affiliated with or endorsed by Games Workshop, and it uses no official artwork, logos or trademarks. The gear sigil is original.</sub>

```
+++ TRANSMISSION ENDS +++
+++ THE MACHINE SPIRIT IS APPEASED +++
```
