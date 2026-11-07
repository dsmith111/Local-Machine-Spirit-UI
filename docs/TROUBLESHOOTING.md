# ☠ The Codex of Malfunctions
*Troubleshooting the Local Cogitator Interface*

> *"When the spirit is troubled, the adept consults the logs before the litanies."*

Each entry gives the **symptom**, its **cause**, and the **rite of repair** (the fix). Commands assume you're in the project folder and running the systemd service from `./scripts/install-service.sh`. If you're not, swap in your own process manager.

**Quick reference**

| What you're checking | Command |
|---|---|
| Is the cogitator running? | `systemctl status local-cogitator-interface` |
| Cogitator logs (live) | `journalctl -u local-cogitator-interface -f` |
| Does the cogitator answer locally? | `curl -I http://127.0.0.1:8080` → `HTTP/1.1 200 OK` |
| Can the cogitator reach the harness? | `curl http://127.0.0.1:8080/api/agent/health` |
| Does the harness answer directly? | `curl http://127.0.0.1:<harness-port>/v1/models` (add `-H "Authorization: Bearer <key>"` if it needs one) |
| Which version is my phone running? | **Configuration Rites** (gear icon) → build number at the bottom |

**Contents**

1. [Running the cogitator](#i-running-the-cogitator)
2. [Reaching it from your phone](#ii-reaching-it-from-your-phone)
3. [Connecting to your harness](#iii-connecting-to-your-harness)
4. [Hermes Agent specifics](#iv-hermes-agent-specifics)
5. [Chatting](#v-chatting)
6. [The installed app (PWA)](#vi-the-installed-app-pwa)
7. [Starting over](#vii-starting-over)

---

## I. Running the cogitator

### `npm start` takes over my terminal
**Cause:** that's normal. `npm start` runs the server in the foreground until you press Ctrl+C or close the terminal.

**Rite of repair:** for background running and starting at boot, install it as a service:
```bash
./scripts/install-service.sh        # same as: npm run service:install
```
Stop any `npm start` first, or the two will fight over port 8080.

### The service won't start
Read the logs first: `journalctl -u local-cogitator-interface -n 50`.

| Log says | Cause | Fix |
|---|---|---|
| `status=217/USER` | The unit names a user that doesn't exist. Usually `deploy/local-cogitator-interface.service` was copied with its `<user>` placeholder | Re-run `./scripts/install-service.sh`. It writes the real values |
| `status=200/CHDIR` | The unit's folder doesn't exist (placeholder path, or you moved the project) | Re-run `./scripts/install-service.sh` from the project's current location |
| `status=203/EXEC` or `node: No such file or directory` | systemd can't find Node. It doesn't load your shell profile, so nvm, fnm and asdf installs are invisible to it | Re-run the installer, or point it at Node explicitly: `NODE_BIN=$(which node) ./scripts/install-service.sh` |
| `EADDRINUSE` | Something already uses the port, often a forgotten `npm start` | Stop it (`sudo lsof -i :8080` shows what holds the port), or change `PORT` in `.env` |
| `Node … is too old` | The installer found Node older than 18 | Upgrade Node, then re-run the installer |

Re-run the installer whenever you move the folder or upgrade Node.

### I changed `.env` but nothing happened
**Cause:** `.env` is only read at startup.

**Rite of repair:** `sudo systemctl restart local-cogitator-interface`

### Not on systemd (macOS, Windows, Docker)
Use any process manager that runs `node server.js` in the project folder. For example, `npx pm2 start server.js --name cogitator`, or a launchd plist on macOS.

---

## II. Reaching it from your phone

### The page won't load at all
Work through these in order.

1. **Type the scheme.** Enter `http://192.168.x.x:8080`, including the `http://`. Without it, many phone browsers try `https://` first, which the cogitator doesn't speak, and the page silently fails or hangs.
2. **Check it locally on the host:**
   ```bash
   curl -I http://127.0.0.1:8080        # should be 200 OK
   curl -I http://<host-lan-ip>:8080    # same, through the network address
   hostname -I                          # confirm the host's current IP
   ```
   If the first works and the second doesn't, the cogitator is listening only on localhost. See the next entry.
3. **Firewall:** `sudo ufw status`. If it's active, run `sudo ufw allow 8080/tcp`.
4. **Same network:** the phone must be on the same Wi-Fi, not on mobile data or a guest network. Guest networks usually block traffic between devices.

### It works on the host but not from other devices
**Cause:** `HOST=127.0.0.1` (the default) only accepts connections from the same machine. That's correct when a reverse proxy on the same machine provides HTTPS (Tailscale serve, Caddy, nginx).

**Rite of repair:** to reach it directly over your local network with no proxy, set `HOST=0.0.0.0` in `.env` and restart. Only do this on a network you trust, and set `COGITATOR_ACCESS_CODE`.

### It loads over `http://`, but I can't install it properly
**Cause:** browsers only give full app features to **HTTPS** sites (or `localhost`). Over plain `http://` on a network address, chat works in the browser, but:
- there's no offline mode and no service worker,
- notifications won't work,
- Android won't offer **Install app**, and on iOS **Add to Home Screen** gives you a lighter shortcut.

**Rite of repair:** put HTTPS in front of the cogitator. See [Rite the Third in the README](../README.md#rite-the-third-open-the-noospheric-conduit). On a home network, Tailscale is the least work: `sudo tailscale serve --bg 8080`. Traffic still flows device-to-host; Tailscale just adds a valid certificate. Afterwards, set `HOST` back to `127.0.0.1`.

---

## III. Connecting to your harness

### The status light is red ("Spirit unresponsive")
The cogitator can't reach the harness. Check from the host:
```bash
curl http://127.0.0.1:8080/api/agent/health    # through the cogitator
curl http://127.0.0.1:<harness-port>/v1/models # the harness directly
sudo lsof -i :<harness-port>                   # is anything listening at all?
```
- **Nothing is listening:** the harness's API isn't running, or runs on another port. For Hermes, see [Hermes Agent specifics](#iv-hermes-agent-specifics).
- **The harness answers directly but not through the cogitator:** `AGENT_URL` in `.env` is wrong. It should be the base URL **without** `/v1`, e.g. `http://127.0.0.1:11434`. Restart after fixing it.
- **The harness is on another machine:** make sure it listens on a network address (not only `127.0.0.1`) and that its port is open in that machine's firewall.

### Startup log says `AGENT_API_KEY is not set`
That's only a note, and it's fine for backends without auth (Ollama, LM Studio). If your harness requires a key (Hermes always does), set `AGENT_API_KEY` in `.env` to the same value the harness expects, then restart.

### "The cogitator rejects thy access cipher"
**Cause:** the cogitator's own passphrase doesn't match. This is `COGITATOR_ACCESS_CODE`, which is separate from the harness key.

**Rite of repair:** enter the exact value of `COGITATOR_ACCESS_CODE` under **Configuration Rites → Access cipher**.

### "The machine spirit rejected the relay's credentials"
**Cause:** the harness returned 401, so `AGENT_API_KEY` doesn't match the harness's key.

**Rite of repair:** make the two keys identical, then restart **both** the harness and the cogitator. For Hermes there's a [one-command fix](#rotate-the-key-everywhere-in-one-command).

### "Rite failed (404)", or model-not-found errors
**Cause:** the backend doesn't know the model name. With `AGENT_MODEL` empty, the cogitator uses the first model the backend lists on `/v1/models`, which may not be the one you want.

**Rite of repair:** set `AGENT_MODEL` explicitly (for Ollama, a name from `ollama list`, such as `qwen2.5-coder:32b`) and restart.

---

## IV. Hermes Agent specifics

### `hermes gateway status` says it's up, but nothing listens on port 8642
**Cause:** the gateway runs its other platforms (Telegram and so on) whether or not the API server is on. The API server only starts when **all** of these are true:

1. `API_SERVER_ENABLED=true` is in the `.env` of the profile the gateway uses: `~/.hermes/.env`, or `~/.hermes/profiles/<name>/.env` for a named profile.
2. `API_SERVER_KEY` is **at least 16 characters and not a placeholder** (`changeme`, `placeholder`, `example`, `dummy`, `your_..._here`, …). A weak key makes Hermes refuse to open the port. The only sign is a line in its log.
3. The gateway was **restarted** after the edit.

Find the reason in the log:
```bash
hermes logs gateway -n 200 | grep -i "api server\|api_server"
```
| Log line | Meaning |
|---|---|
| `API server listening on http://127.0.0.1:8642` | Working |
| `Refusing to start: API_SERVER_KEY is required…` | Key missing |
| `Refusing to start: API_SERVER_KEY is a placeholder or too short (<16 chars)…` | Key too weak |
| *(no API server lines at all)* | `API_SERVER_ENABLED` isn't being read: wrong file or profile, or no restart |

### Rotate the key everywhere in one command
This generates a strong key, replaces the old values in both `.env` files, restarts both services, and checks the result. Adjust `H` (Hermes `.env`) and `C` (cogitator `.env`) if your paths differ:

```bash
K=$(openssl rand -hex 32); H=~/.hermes/.env; C=~/Local-Machine-Spirit-UI/.env; touch "$H" "$C"; sed -i -e '/^[[:space:]]*\(export[[:space:]]\+\)\?API_SERVER_\(ENABLED\|KEY\)[[:space:]]*=/d' -e '$a\' "$H" && printf 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=%s\n' "$K" >> "$H" && sed -i -e '/^[[:space:]]*\(export[[:space:]]\+\)\?\(AGENT\|HERMES\)_API_KEY[[:space:]]*=/d' -e '$a\' "$C" && echo "AGENT_API_KEY=$K" >> "$C" && hermes gateway restart && sudo systemctl restart local-cogitator-interface && for i in 1 2 3 4 5 6 7 8 9 10; do sleep 3; curl -sf http://127.0.0.1:8642/health && break; done; echo; curl -s -o /dev/null -w "Cogitator: %{http_code}\n" http://127.0.0.1:8080/api/agent/health
```
Success prints `{"status": "ok"}` and then `Cogitator: 200`. The command uses GNU `sed` (standard on Linux). On macOS, install `gnu-sed` and use `gsed`.

### Hermes rejects the model at startup
Hermes needs at least a **64k context window**. Ollama defaults to much less on smaller GPUs. Run Ollama with `OLLAMA_CONTEXT_LENGTH=64000` or higher, or set `context_length` in Hermes' model config.

---

## V. Chatting

### Replies arrive all at once instead of streaming
**Cause:** a reverse proxy between your phone and the cogitator buffers the response.

**Rite of repair:** turn buffering off. In nginx, set `proxy_buffering off;` and `proxy_read_timeout 1h;`. Caddy and Tailscale serve stream without extra settings.

### Long tasks get cut off
**Cause:** a proxy timeout. Agent runs that use tools can take minutes.

**Rite of repair:** raise the proxy's read timeout (nginx `proxy_read_timeout 1h;`). The cogitator itself sets no timeout on agent runs.

### "The spirit is overburdened with concurrent rites" (429)
**Cause:** the harness's limit on concurrent runs is reached (Hermes defaults to 10).

**Rite of repair:** wait for other runs to finish, or raise the limit (Hermes: `gateway.api_server.max_concurrent_runs`).

### Tool lines, approvals or reasoning never appear
**Cause:** these need the [extended protocol](../README.md#-vii-the-extended-litanies). Plain model servers (Ollama, LM Studio, vLLM) don't send them, and reasoning only appears for models that produce it.

**Rite of repair:** none needed. Plain chat works without them. For the full set, use a harness that supports the extensions, such as Hermes Agent.

### Text flashes or flickers while the spirit speaks
This was fixed in build `2026.11.07-r4`. If you still see it, first check the build number (see [the app shows an old version](#the-app-shows-an-old-version-after-updating)). If you're on the latest build, try turning off **Cathode effects** in Configuration Rites and [open an issue](https://github.com/dsmith111/Local-Machine-Spirit-UI/issues) with your device and browser.

---

## VI. The installed app (PWA)

### The app shows an old version after updating
**Cause:** your phone kept a cached copy of the old app.

**Rite of repair:**
1. On the host: `git pull && sudo systemctl restart local-cogitator-interface`.
2. On the phone: close the app completely (swipe it away), then reopen it.
3. Check the build number at the bottom of **Configuration Rites**. If it's still old (or missing), pull down to refresh once.

### iPhone: a plain strip at the top or bottom of the installed app
**Cause:** iOS 26 can report a screen area to installed web apps that stops short of the real screen edge ([WebKit bug 316008](https://bugs.webkit.org/show_bug.cgi?id=316008)). The cogitator fills that strip with matching casing colour, so you should see at most a seamless dark band.

**Rite of repair:** if a visibly different strip remains, remove the app from the home screen and add it again. iOS fixes some of an app's screen-size behaviour at install time. Removing the app may delete its saved conversations, so treat this as a last resort.

### No notifications
Notifications need **all** of the following:
- the site served over **HTTPS**,
- on iPhone, the app **added to the Home Screen** (iOS 16.4 or newer) and opened from there,
- permission granted when the app asks (it asks on your first message),
- the app in the background when the reply or approval request arrives.

If you declined once, re-enable notifications in the phone's settings for the app or site.

### I can't find the Install option
- **iOS:** only Safari's **Share → Add to Home Screen** installs it. Other iOS browsers vary.
- **Android:** Chrome offers **Install app** only over HTTPS. See [installing over plain HTTP](#it-loads-over-http-but-i-cant-install-it-properly).

---

## VII. Starting over

- **Clear conversations on one device:** Configuration Rites → **Purge Archives**.
- **Reset all settings on one device:** clear the site's data in the browser (iOS: Settings → Apps → Safari → Advanced → Website Data), or remove and re-add the installed app.
- **Remove the service:** `./scripts/install-service.sh --uninstall`.
- **Reset the cogitator config:** `cp .env.example .env`, fill it in again, then restart.

---

<p align="center"><a href="../README.md">⟵ Return to the README</a></p>

```
+++ IF THE SPIRIT REMAINS TROUBLED, CONSULT THE LOGS AND OPEN AN ISSUE +++
```
