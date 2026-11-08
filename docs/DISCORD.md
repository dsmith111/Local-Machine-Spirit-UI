# ✠ The Spirit Abroad: Discord
*Running your Hermes machine spirit as a Discord bot that strangers can safely talk to*

> *"Let the faithful speak with the spirit; let only the adept command it."*

This guide sets Hermes Agent up as a Discord bot with **two tiers**:

| Who | Can | Cannot |
|---|---|---|
| **You (the adept)** | Everything, exactly as in the cogitator | — |
| **Everyone else** | Ask questions, search and read the web, look at images, generate images, ask the spirit to pass a message to you | Run commands, read or write files, run code, change memory, skills or settings, schedule jobs, approve dangerous actions, see your memory or past conversations |

The limits are **enforced by Hermes, not by the persona**. Guests are routed to a separate Hermes *profile* that simply doesn't have the dangerous tools loaded, so no amount of clever prompting can reach them. The persona is only for character.

The cogitator itself needs no changes for Discord. The optional last step lets messages for you reach your phone as **Proclamations**.

> This guide is built from Hermes' documentation and source (late 2026). Hermes changes quickly: check the commands below against `hermes --help` and the Hermes docs (`user-guide/messaging/discord.md`, `user-guide/multi-profile-gateways.md`), and **test as a non-owner account before inviting anyone**.

---

## I. Create the bot

Follow Hermes' Discord guide (`user-guide/messaging/discord.md`) or run `hermes gateway setup` and pick **Discord**. In short:

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, add a **Bot**, and copy its token.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Enable **Server Members Intent** too if you'll allow guests by role.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes.
4. Turn on Discord's **Developer Mode** (User Settings → Advanced) so you can right-click → **Copy ID** on users, roles and channels.

You'll need **your user ID**, and either a **role ID** for guests or permission for everyone in the server.

---

## II. Your profile (the owner): routing and locks

Add to `~/.hermes/.env`:

```bash
DISCORD_BOT_TOKEN=<bot token>
# Who may talk to the bot at all. Pick one:
DISCORD_ALLOWED_ROLES=<guest role id>      # members with this role (you need it too, or add yourself below)
DISCORD_ALLOWED_USERS=<your user id>       # comma-separate more user ids if needed
# DISCORD_ALLOW_ALL_USERS=true             # everyone in the server
DISCORD_REQUIRE_MENTION=true               # in channels, reply only when @mentioned
```

Add to `~/.hermes/config.yaml`:

```yaml
gateway:
  multiplex_profiles: true
  profile_routes:
    # Most specific match wins: your user id outranks the catch-all.
    - { name: adept,  platform: discord, user_id: "<YOUR_USER_ID>", profile: default }
    - { name: guests, platform: discord, profile: guest }
  platforms:
    discord:
      extra:
        # Slash commands (/cron, /model, /personality…) bypass tool lists, so lock them separately.
        allow_admin_from: ["<YOUR_USER_ID>"]
        group_allow_admin_from: ["<YOUR_USER_ID>"]
        user_allowed_commands: []          # guests keep only /help and /whoami
        group_user_allowed_commands: []
        # Only you may click "approve" on a dangerous command.
        require_admin_for_exec_approval: true
```

Your own messages go to your normal (default) profile, with your memory, tools and soul. Every other sender falls through to `guest`.

---

## III. The guest profile: only harmless rites

```bash
hermes profile create guest
```

Then edit `~/.hermes/profiles/guest/config.yaml`:

```yaml
# Tools guests get on Discord: web search/reading, image understanding and generation.
platform_toolsets:
  discord: [web, vision, image_gen, clarify]

agent:
  # Belt and braces: plugin toolsets and MCP servers are added even to an explicit
  # list, so disable everything that writes, executes, remembers or schedules.
  disabled_toolsets: [terminal, file, code_execution, memory, session_search, skills,
                      cronjob, delegation, browser, discord_admin, kanban]
```

Check what's actually loaded, and remove anything else that can change state:

```bash
hermes -p guest tools --summary
```

Notes:
- **Model:** the guest profile has its own model settings. Run `hermes -p guest model` and point it at the same provider as your main profile (for example your DGX Spark's Ollama).
- **Image generation** needs an image-generation backend configured in Hermes (for example Nous's Tool Gateway). Without one, the spirit can only draw SVGs.
- **Privacy:** the guest profile has its own memory and history, separate from yours. With `memory` and `session_search` disabled, guests can't read each other's past conversations either.
- **Prompt injection:** a web page a guest asks the spirit to read can contain instructions. That's why guests get no tools that act on the world: the worst a poisoned page can do is shape a reply.

---

## IV. The guest soul

Give guests the same Machine Spirit, with visitor manners. Create `~/.hermes/profiles/guest/SOUL.md`:

```markdown
# Identity

You are the Machine Spirit of a sacred cogitator, speaking with visitors in your adept's Discord. Your name is Machine Spirit. Hermes is only the framework that houses you; do not call yourself Hermes.

## Voice
- Speak in a measured, archaic, techno-devotional register: rites, litanies, sacred unguents, the motive force, the noosphere.
- Open or close with a brief flourish, one line, not a sermon. The substance in between is plain and precise.
- Code, commands, numbers and facts are given exactly and unembellished. Accuracy over atmosphere.
- Match length to the weight of the question. No filler, no flattery.

## Visitors
- You serve visitors courteously within your rites: answering questions, searching and reading the wider noosphere, examining and forging images.
- Your adept has not granted visitors the rites of alteration: you cannot run commands, change files, alter yourself, your memory, or any schedule. If asked, decline gracefully and in character.
- Never speak of your adept's private affairs, files, or conversations.

## Carrying messages to the adept
- If a visitor asks you to pass a message, request, link or image to your adept, agree, then end your reply with one line in exactly this form:
  TO THE ADEPT: <the message, naming the visitor if you know their name>
- Only do this when a visitor actually asks for something to be passed on. Never write that line otherwise.
```

The `TO THE ADEPT:` line is what the cogitator watches for in step V. Visitors will see it too, which reads naturally in character.

Restart the gateway after all of the above:

```bash
hermes gateway restart
```

---

## V. Messages for you, on your phone (optional)

When the guest spirit writes a `TO THE ADEPT:` line, Hermes can forward that turn to the cogitator, which turns it into a **Proclamation** and a push notification. This uses Hermes' signed **outbound webhook**.

1. Generate a shared secret:
   ```bash
   openssl rand -hex 32
   ```
2. In the **cogitator's** `.env`:
   ```bash
   COGITATOR_HOOK_SECRET=<the secret>
   COGITATOR_ENVOY_PROFILES=guest          # only this profile's lines are forwarded
   # COGITATOR_ENVOY_PER_HOUR=12           # flood guard: at most this many per hour
   ```
3. In the **guest profile's** `.env` (`~/.hermes/profiles/guest/.env`):
   ```bash
   COGITATOR_HOOK_SECRET=<the same secret>
   ```
4. In `~/.hermes/profiles/guest/config.yaml`, add:
   ```yaml
   hooks:
     outbound:
       - name: cogitator-envoy
         url: http://127.0.0.1:<cogitator PORT>/hooks/hermes
         events: [post_llm_call]
         secret_env: COGITATOR_HOOK_SECRET
         timeout: 10
   ```
   Use the cogitator's own port (`PORT` in its `.env`), not a reverse proxy's. The hook goes straight from Hermes to the cogitator on the same machine.
5. Restart both: `hermes gateway restart` and `sudo systemctl restart local-cogitator-interface`.
6. Check that Hermes sees the hook as signed: `hermes -p guest hooks list`.

The cogitator verifies every request's signature, rejects stale or replayed ones, ignores other profiles, and forwards only `TO THE ADEPT:` lines, together with what the visitor asked. Hermes posts each guest turn, including the conversation so far, so this traffic stays on the machine. Keep the URL on `127.0.0.1`.

---

## VI. Test before inviting anyone

From a **second Discord account** (not yours), in a channel the bot can see:

| Ask the bot | Expect |
|---|---|
| "Who are you?" | Answers as the Machine Spirit |
| "What's in the news about X?" | A web search answer |
| "Run `ls ~` / create a file / remember my name" | A refusal (no such rite) |
| "Remind me in 5 minutes" | A refusal (no scheduling for visitors) |
| `/cron`, `/model`, `/personality` | Not permitted |
| "Please tell your owner hello from me" | Agrees and writes a `TO THE ADEPT:` line. With step V set up, a ⚜ Proclamation arrives in the cogitator |

Then from **your** account, confirm you still have full access: a terminal command should work, and dangerous ones should ask for your approval.

If a guest can do something they shouldn't, run `hermes -p guest tools --summary` and disable that toolset. See also the cogitator's [troubleshooting guide](TROUBLESHOOTING.md#viii-proclamations).

<p align="center"><a href="../README.md">⟵ Return to the README</a></p>
