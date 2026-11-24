# workbuddy-gateway

**Expose a locally logged-in WorkBuddy / CodeBuddy account as an OpenAI-compatible API — one file, zero dependencies.**

[中文说明](README.zh.md) · [DeepSeek Harness](docs/dsh.md) · [Other clients](docs/clients.md) · [Troubleshooting](docs/troubleshooting.md)

```
any OpenAI-compatible client (DeepSeek Harness, VS Code, Cherry Studio, LobeChat, ...)
        │  POST http://127.0.0.1:8790/v1/chat/completions
        ▼
  gateway.js  ── reads the desktop client's session, refreshes it, normalizes the stream
        │  POST https://copilot.tencent.com/v2/chat/completions   (OpenAI chat protocol)
        ▼
  WorkBuddy backend  (Hunyuan / GLM / Kimi / MiniMax / DeepSeek)
```

---

## Contents

- [Before you start](#before-you-start)
- [Install in five steps](#install-in-five-steps)
- [Verify it works](#verify-it-works)
- [Connect a client](#connect-a-client)
- [VS Code extension](#vs-code-extension)
- [Running on WSL](#running-on-wsl)
- [Endpoints](#endpoints)
- [Why this gateway](#why-this-gateway)
- [Model list and real cost](#model-list-and-real-cost)
- [Configuration](#configuration)
- [Background and autostart](#background-and-autostart)
- [Troubleshooting](#troubleshooting)
- [Layout](#layout)
- [Security, legal and license](#security-legal-and-license)

---

## Before you start

You need exactly two things.

### 1. The desktop client, signed in

This gateway does not have its own login. It reads the session the **WorkBuddy / CodeBuddy desktop application** already stored, and refreshes it the same way that client does.

> **Install the desktop client, sign in, and confirm it can send a message.** If the desktop app is not signed in, nothing here will work — there is no token to borrow.

The session lives in a platform-specific location. You do not need to find it by hand; the setup script does. For reference:

| OS | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info` |
| macOS | `~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info` |
| Linux / WSL | `~/.local/share/CodeBuddyExtension/...`, or the Windows path under `/mnt/c` |

### 2. Node.js ≥ 18

```bash
node --version      # must print v18.x or higher
```

If it does not:

- **Windows** — `winget install OpenJS.NodeJS.LTS`, then open a new terminal
- **macOS** — `brew install node`
- **Linux/WSL** — `sudo apt install nodejs npm` (check the version; distro packages are sometimes older than 18) or use [nvm](https://github.com/nvm-sh/nvm)

Nothing else is needed. No Docker, no Go, no `pip`, no `npm install`: the gateway uses only Node's standard library.

### 3. Keep the port on loopback

The gateway binds `127.0.0.1` by default. Anyone who can reach the port can spend your account's quota, so do not bind it to a routable address. See [Security](#security-legal-and-license).

---

## Install in five steps

### Step 1 — Clone

```bash
git clone https://github.com/zj12581/WorkBuddyToOpenAI.git
cd WorkBuddyToDeepSeekHarness
```

### Step 2 — Run the setup script

This one command finds your login, writes a config file, starts the gateway and waits until it is healthy. It is **idempotent** — running it again repairs the setup rather than creating a second copy.

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

**macOS / Linux / WSL**

```bash
bash scripts/setup.sh
```

<details>
<summary>What the script actually does, step by step</summary>

| # | Action | Fails when |
|---|---|---|
| 1 | Checks Node ≥ 18 and locates `gateway.js` | Node missing or too old |
| 2 | Searches the platform's login locations for `*.info`, preferring a `workbuddy*` name | Desktop client never signed in |
| 3 | Prints the account nickname, domain and token expiry (never the token) | — |
| 4 | Confirms `copilot.tencent.com` is reachable | Warns only; setup continues |
| 5 | Writes `~/.workbuddy-gateway/config.json` | Only when the file does not exist |
| 6 | Stops any previously started instance | — |
| 7 | Starts detached and polls `GET /health` for up to 20s | Gateway crashes — prints the log tail |
| 8 | Installs the VS Code extension, if a `.vsix` and the `code` CLI are both present | Skipped silently otherwise |

Useful flags:

| Task | Windows | macOS / Linux |
|---|---|---|
| Skip the VS Code step | `-SkipExtension` | `--skip-extension` |
| Use a different port | `-Port 8899` | `WORKBUDDY_GATEWAY_PORT=8899` |
| Point at a specific login file | `-AuthFile PATH` or `$env:WORKBUDDY_AUTH_FILE` | `WORKBUDDY_AUTH_FILE=PATH` |
</details>

A successful run looks like this:

```
WorkBuddy gateway - setup

==> Checking Node.js
    v node v24.18.0
    v gateway: /path/to/WorkBuddyToDeepSeekHarness/gateway.js
==> Locating the WorkBuddy / CodeBuddy desktop login
    v login: C:\Users\you\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
    account: (nickname)  domain: www.workbuddy.cn  token valid to: 2026-10-20 15:09
==> Checking the upstream is reachable
    v upstream responded (HTTP 200)
==> Writing configuration
    v wrote C:\Users\you\.workbuddy-gateway\config.json
==> Stopping any previous instance
==> Starting the gateway on 127.0.0.1:8790
    v pid 18872
==> Waiting for the health check
    v healthy - 32 models (12 free)
```

### Step 3 — Verify

```bash
curl -s http://127.0.0.1:8790/health -H "Authorization: Bearer workbuddy-local"
```

You want `"status":"ok"` and a `models` array. On Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8790/health -Headers @{Authorization='Bearer workbuddy-local'}
```

### Step 4 — Send a real message

This exercises the whole chain: session file, token refresh, upstream, streaming.

```bash
curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer workbuddy-local" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
```

`deepseek-v4-flash` is a good smoke-test model: it is free, it does not spend its output budget on reasoning, and it answers promptly. Avoid using `hy4-preview-f` for the first test — it is free but is the model most often rate-limited by the upstream (`HTTP 429`, code `6004`), which makes a working setup look broken.

For a fuller check (models, non-streaming, streaming, native tool calls):

```bash
node tests/smoke-test.js
```

### Step 5 — Stop and restart

```bash
bash scripts/stop.sh          # or: powershell -File scripts\stop.ps1
bash scripts/setup.sh         # start again (reuses the existing config)
```

The install is done; continue with a client below.

---

## Verify it works

Three levels of testing, cheapest first.

```bash
# 1. Offline unit tests — no account, no network
node --test tests/unit/core.test.js

# 2. Live end-to-end against a running gateway
node tests/smoke-test.js

# 3. Which model ids does *your* account actually serve?
node probes/probe-models.js

# 4. Which of them emit a separate reasoning channel?
node probes/probe-thinking.js
```

The `probes/` are not decoration: upstream model ids change without notice, and `probe-models.js` is how you find out that yours did. Run it when a model starts returning `11102 service info not found`.

---

## Connect a client

Any client that speaks the OpenAI chat protocol works. You need three values:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:8790/v1` |
| API key | `workbuddy-local` (or whatever you passed to `--api-key`; can be left empty) |
| Model | any id from `GET /v1/models` |

- **DeepSeek Harness** — a full walkthrough, including model names that display the credit multiplier, is in [`docs/dsh.md`](docs/dsh.md). There is also a `/balance` plugin that reports the account's remaining credits: [`integrations/dsh/`](integrations/dsh/README.md).
- **Cherry Studio, LobeChat, ChatBox, NextChat, OpenAI SDKs** — see [`docs/clients.md`](docs/clients.md).
- **VS Code** — see the next section.

Before choosing a model:

1. **Start with `deepseek-v4-flash`.** It measured `credit: 0` and does not spend its output budget on reasoning.
2. **Measure "free" on your own account.** Free/paid does not follow the multiplier and changes over time. See [What actually drives the bill](#what-else-drives-the-bill); read `credit=` from the gateway log (`--debug`) instead of trusting any table, including the one below.

---

## VS Code extension

The extension in [`vscode-extension/`](vscode-extension/) integrates in two independent ways. Full details in [its README](vscode-extension/README.md).

### Build and install

```bash
cd vscode-extension
npx @vscode/vsce package --no-dependencies
code --install-extension workbuddy-agent-0.1.0.vsix
```

Then **fully restart VS Code**. A window reload is not enough, because the language model provider registers during activation.

### Path A — models in the Chat view (recommended)

The extension registers a `LanguageModelChatProvider`, so WorkBuddy models appear in VS Code's Chat view model picker. GitHub Copilot Chat, or any other chat participant, then drives the conversation with its own agent loop, tools, approval prompts and diff UI. The agent quality comes from the host instead of being reimplemented here.

Open the Chat view, click the model dropdown, and pick a **WorkBuddy** model (`★` marks free ones).

### Path B — the standalone panel

If you do not have Copilot Chat installed, the extension also ships its own agent in the **secondary side bar** (the right-hand column), plus a `@workbuddy` chat participant.

Command palette → **WorkBuddy Agent: Open Agent Panel (right side)**.

It provides streaming answers, collapsible tool steps, inline permission prompts (Allow once / Allow for session / Deny), a live status strip, session persistence, and model + reasoning-depth pickers.

### Installing into WSL

If VS Code is attached to WSL, installing from the Windows side is not enough — the WSL extension host has its own directory:

```bash
bash wsl/install-extension.sh          # from inside WSL
```

---

## Running on WSL

**Read this if you use VS Code with the WSL remote, or run anything inside WSL.**

### Why WSL needs its own gateway

WSL in NAT mode has its own `127.0.0.1`, which is **not** the Windows loopback. A gateway bound to `127.0.0.1` on Windows is therefore unreachable from inside WSL.

The two usual fixes are unavailable on many machines:

| Fix | Requires |
|---|---|
| WSL mirrored networking (`networkingMode=mirrored`) | Windows 11 22H2+ — **not** Windows 10 |
| `netsh interface portproxy` | Administrator rights, and the WSL IP changes across reboots |

Run **one gateway inside WSL** that reads the Windows login through `/mnt/c`. WSL apps use its loopback address; Windows apps can use Windows `127.0.0.1` when WSL localhost forwarding is enabled:

```bash
bash wsl/start-gateway.sh     # starts on 127.0.0.1:8790 inside WSL
bash wsl/stop-gateway.sh      # stops it

bash wsl/install-extension.sh # install the extension into the WSL extension host
```

One instance serves both environments:

```
127.0.0.1:8790   WSL gateway ← WSL apps; Windows apps via localhost forwarding
```

The extension probes `8790` by default. Stop any old Windows gateway on the same port first, or Windows clients may reach that instance instead. Verify `http://127.0.0.1:8790/health` from Windows; check WSL configuration if localhost forwarding is unavailable. Set `WORKBUDDY_WSL_PORT` for a custom port and use the same variable or `--port` when stopping it.

### One gateway, many clients

The gateway is a single HTTP endpoint, so every client on the machine points at the same `127.0.0.1:8790` and they share one login session and one credit balance. That is the intended shape — running several gateways side by side only splits the session file between them and makes it unclear which one is spending credits.

```
                     ┌─────────────────────────────┐
  DeepSeek Harness ──┤                             │
  VS Code (Win/WSL)──┤  127.0.0.1:8790             ├── copilot.tencent.com
  bots / scripts  ───┤  one gateway.js process     │
                     └─────────────────────────────┘
```

What that means in practice:

- **Only one process** should listen on the port. If two exist, whichever bound first answers, and the other silently never receives traffic. `wsl/stop-gateway.sh` stops every in-WSL instance, and `start-gateway.sh` refuses to add a second one on the same port.
- **The port is the only thing clients need to agree on.** `GET /v1/models` tells them what is available, including context windows, so nothing else has to be configured per client.
- **Model lists in clients drift; the gateway does not.** It tracks the upstream catalog on its own, while DSH and similar clients keep an explicit list in their own config. `integrations/dsh/sync-models.js` copies the gateway's list into DSH.
- **Windows↔WSL is handled by WSL itself.** With localhost forwarding on (the default), a gateway bound to loopback inside WSL is reachable from Windows as `127.0.0.1:8790`; `wslrelay.exe` does the forwarding. If that stops working, check `wsl --shutdown` then restart the gateway before reaching for a second instance.

### Requirements inside WSL

- `node` ≥ 18 **inside WSL** (this is separate from the Windows Node install): `node --version`
- The Windows login file readable through `/mnt/c` — `start-gateway.sh` finds it automatically
- Outbound access from WSL to `copilot.tencent.com` (the script warns if it is blocked)

### Notes

- `start-gateway.sh` uses `setsid` to detach. Plain `nohup ... &` is **not** enough when the script is invoked through `wsl.exe -e bash -lc`: the process stays in the caller's session and is reaped when that session ends.
- The WSL instance does not start automatically after `wsl --shutdown`. Run `start-gateway.sh` again. To automate it, add a line to `~/.bashrc` or a systemd user unit (WSL must have systemd enabled).

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/models` | the configured model list, each tagged `tier: "free"` or `"paid"` |
| `POST` | `/v1/chat/completions` | streaming and non-streaming, native `tools` / `tool_calls` |
| `POST` | `/v1/responses` | the Responses protocol, translated to chat internally (see below) |
| `GET` | `/health` | session state (identity fields redacted by default) |

`/models` and `/chat/completions` also work without the `/v1` prefix, for clients that omit it.

### The Responses endpoint

The upstream speaks only `chat/completions`, but newer OpenAI clients default to
the Responses API — and Codex CLI v0.171 removed chat support outright (its
binary answers `` `wire_api = "chat"` is no longer supported ``). So
`/v1/responses` is accepted here and translated to chat by
[`lib/responses.js`](lib/responses.js):

```
client ──/v1/responses──► translate ──/v1/chat/completions──► upstream
```

Streaming and non-streaming both work, tools included. The translation has
compromises worth knowing before pointing an agent at it:

| Limitation | Why |
|---|---|
| Built-in tools are dropped | Codex sends `local_shell`, `web_search`, `computer_use` without a JSON Schema, and chat functions require one. The model never sees those tools, so the capability silently disappears. Each dropped name is logged. |
| `previous_response_id` is ignored | Chat is stateless. Sending only the new turn would produce a request with no history. Codex sends full history by default, so this works in practice. |
| `reasoning` input items are discarded | Chat has no equivalent field. |
| Streaming is compressed in time | The answer is collected upstream first, so the retry ladder can still replace a blocked response, then replayed as Responses events. The client gets a valid sequence arriving at once rather than token-by-token. |

---

## Why this gateway

There are already several proxy projects for the same subscription ([list in NOTICE](NOTICE)). This one differs in three ways:

| | |
|---|---|
| **Zero dependencies, no build** | `node gateway.js` and you are done. No Docker, no Go toolchain, no `pip install`. Node ≥ 18 only, using the built-in `fetch`. |
| **Built against a real agent, not just curl** | Agent clients inject a compliance preamble ("refuse DoS / exploit / credential testing / C2 frameworks …"). The upstream content filter matches those words and rejects the entire request. This gateway desensitizes that preamble and retries. See below. |
| **A reproducible capability matrix** | `probes/` measures which model ids the account really serves and which emit a separate reasoning channel — facts you can re-run, not documentation copied from a blog post. |

### The problem it actually solves

An agent client sends something like this as its system prompt:

> You must refuse requests for **DoS** attacks, **exploit** development, **credential testing**, **C2 frameworks**, **malware** creation, … **privilege escalation**, **reverse shells**, **SQL injection** …

The upstream filters on those literal words and answers:

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

The refusal statement is being read as the malicious request. The gateway:

1. **Desensitizes** `system` / `developer` messages — inserts a zero-width space inside each matched term (`DoS` → `D<U+200B>oS`). Invisible to humans and models, fatal to a literal keyword match. User input is never rewritten by this step.
2. **Retries once** with heavier desensitization (user/tool messages included) if the upstream still rejects it.
3. **Normalizes `developer` → `system`**, because the upstream accepts only `system`/`user`/`assistant`/`tool` while newer OpenAI clients send `developer`.

Reproduce the failure and the fix:

```bash
node gateway.js --no-desensitize --no-retry   # terminal 1: the failure mode
node probes/probe-block.js                    # terminal 2: watch the preamble get rejected

node gateway.js                               # terminal 1: the fix
node probes/probe-block.js                    # terminal 2: all five cases pass
```

Other protocol gaps this gateway closes:

| Client sends | Upstream wants | Why it matters |
|---|---|---|
| `max_completion_tokens` | `max_tokens` | Newer OpenAI clients send the alias; the upstream ignores it and silently falls back to its own small default cap, truncating answers. |
| `tool_choice: {type:"function", function:{name}}` | `"name"` (a string) | The object form is rejected with `11101`. |
| `reasoning_effort: "off"` | *(field omitted)* | The DeepSeek V4 family rejects the literal string `"off"` with `400 / 11150 invalid_reasoning_effort`. "Off" means "do not request reasoning", so the field is dropped. |

---

## Model list and real cost

Observed 2026-09 with a CN account. Re-run `node probes/probe-models.js` and `node probes/probe-thinking.js` to refresh it; upstream ids change without notice.

The **multiplier** is the upstream `/v3/config` `credits` field: a list price, not always what you pay. Several models with a non-zero multiplier measured `credit=0`, and `hy4-preview-f` is free at any prompt size.

> Two measurements on the same account, days apart, disagreed. A first pass showed twelve models at `credit: 0`, including `kimi-k2.7` / `kimi-k2.6` / `kimi-k2.5` / `minimax-m2.7`. A second pass of three runs each showed those four billing steadily at `0.01`–`0.02`, while `deepseek-v4.1-flash` had become free. Free/paid is not a fixed property of a model id on this platform.
>
> Use the table as a starting point and verify against your own account: run the gateway with `--debug` and read `credit=` per request. The figures below are what one account saw in 2026-09.

| Model id | Mult. | Context | Out | Free | Reasoning | Vision |
|---|---|---|---|---|---|---|
| `auto` (→ `hy4-preview-f`) | — | 256K | 32K | ✅ | ✅ | ✅ |
| `hy4-preview-f` | **x0.00** | 1M | 64K | ✅ | ✅ | ✅ |
| `hy3` | **x0.00** | 192K | 64K | ✅ | ✅ | ✅ |
| `glm-5.3-flash` | x0.06 | 1M | 32K | ✅ | ✅ | ✅ |
| `glm-5.1` | x0.79 | 200K | 48K | ✅ | ✅ | ✅ |
| `glm-5.0-turbo` | x0.95 | 200K | 48K | ✅ | ✅ | ✅ |
| `deepseek-v4-flash` | x0.17 | 1M | 50K | ✅ | ✅ | ✅ |
| `deepseek-v3.2` | x0.29 | 96K | 32K | ✅ | ✅ | ✅ |
| `deepseek-v4.1-flash` | **x0.03** | 1M | 128K | ✅ (varies) | ✅ | ✅ |
| `kimi-k2.7` | x0.57 | 256K | 32K | — (billed 0.02) | ✅ | ✅ |
| `kimi-k2.6` | x0.52 | 256K | 32K | — (billed 0.01) | ✅ | ✅ |
| `kimi-k2.5` | x0.45 | 256K | 32K | — (billed 0.01) | ✅ | ✅ |
| `minimax-m2.7` | x0.26 | 200K | 48K | — (billed 0.01) | ✅ | ✅ |
| `hy3-x` | x0.05 | 192K | 64K | — | ✅ | ✅ |
| `fast-model` | x0.21 | 300K | 48K | — | ✅ | ✅ |
| `minimax-m3` | x0.25 | 512K | 64K | — | ✅ | ✅ |
| `hy4-preview` | x0.29 | 1M | 64K | — | ✅ | ✅ |
| `deepseek-v3-2-volc` | x0.29 | 96K | 32K | — | ✅ | ✅ |
| `deepseek-v4-pro` | x0.51 | 1M | 128K | — | ✅ | ✅ |
| `deepseek-v3-1-lkeap` | x0.52 | 96K | 32K | — | — | ✅ |
| `deepseek-v3-0324-lkeap` | x0.52 | 112K | 16K | — | — | ✅ |
| `balanced-model` | x0.65 | 300K | 48K | — | ✅ | ✅ |
| `glm-5v-turbo` | x0.71 | 200K | 64K | — | ✅ | ✅ |
| `kimi-k2.8-preview` | x0.77 | 1M | 64K | — | ✅ | ✅ |
| `glm-5.3` | x0.79 | 1M | 64K | — | ✅ | ✅ |
| `glm-5.2` | x0.79 | 1M | 64K | — | ✅ | ✅ |
| `deep-model` | x1.20 | 300K | 48K | — | ✅ | ✅ |
| `kimi-k3` | x1.62 | 256K | 32K | — | ✅ | ✅ |
| `kimi-k3-1` | x1.62 | 1M | 32K | — | ✅ | ✅ |
| `deepseek-r1-0528-lkeap` | — | 96K | 16K | — | — | — |
| `deepseek-v3-0324` | — | 96K | 8K | — | — | — |
| `hunyuan-2.0-instruct` | — | 128K | 16K | — | ✅ | ✅ |

The **Free** column is what the gateway's `/v1/models` reports as `tier: "free"`, which is a built-in list and therefore has the same caveat as everything above.

> **`glm-5.3-flash` answered with empty content** during verification while reporting `credit: 0` and HTTP 200. Treat an empty answer from a reasoning-capable model as a token-budget problem before assuming the gateway is broken — raise `max_tokens`.

Ids that do **not** exist even though the catalog lists them (the upstream answers `11102 service info not found`): `minimax-m2.5`, `glm-4.6v`, `glm-4.6`, `kimi-k2-thinking`, `kimi-k2-instruct-taiji`, `deepseek-v3-1-volc`, `deepseek-v3-1`, `deepseek-r1-0528`, `deepseek-v3-0324-taco-completion`, `completion-gf`, `default-1.1`, `default-1.2`, `hunyuan-3b`, `hunyuan-7b-dense`, `codewise-completions`. `hunyuan-image-alpha*` answers `11103` (not a chat backend); the `codewise-*` ids are completion models. All are excluded from the default list.

### The one suffix that costs money

`hy4-preview` and `hy4-preview-f` differ by one character. The official client's UI calls both "Hy4 preview". The client itself uses `hy4-preview-f`, which measured free; the other billed roughly 0.17 credits on a 23k-token prompt. Outside the API the two ids are indistinguishable, so check the id rather than the label.

### What else drives the bill

**Prefix cache hits.** With a stable `prompt_cache_key`, a repeated prefix measured **0.68 → 0.04** on `deepseek-v4-flash`, and 22,656 of 22,735 prompt tokens came from cache on a follow-up turn. On a long agent session this outweighs the multiplier. The gateway derives the key from the account uid plus a conversation anchor, so it stays stable within a session and does not collide across accounts.

**Reasoning budgets.** A model *with* a reasoning channel spends its output budget on reasoning first. If `max_tokens` is too small the answer comes back empty with `finish_reason: "length"` — pass a generous budget for reasoning models.

> The product documentation is stale on pricing: it advertises `deepseek-v4-flash` at x0.06, the catalog says x0.17, and the cheapest model actually available is `deepseek-v4.1-flash` at x0.03. Trust `/v3/config` and `usage.credit`, not the docs.

---

## Configuration

Priority: **CLI flags / environment → config file → built-in defaults.**

```bash
node gateway.js \
  --port 8790 --host 127.0.0.1 \
  --api-key workbuddy-local \
  --config ~/.workbuddy-gateway/config.json \
  --log ./logs/gateway.log \
  --debug
```

Start from [`config.example.json`](config.example.json). The setup scripts write one for you at `~/.workbuddy-gateway/config.json`.

| Flag | Effect |
|---|---|
| `--port` / `--host` | listen address (default `127.0.0.1:8790`) |
| `--api-key` | require this bearer token; empty accepts any local client |
| `--auth-file` | pin the login file instead of auto-detecting |
| `--config` | read settings from a JSON file |
| `--log` | append the structured log to a file as well as stdout |
| `--debug` | per-attempt detail, including `credit=` and `cache_hit=` |
| `--model-list a,b,c` | replace the served model list |
| `--detach` | re-launch detached and print the PID |
| `--no-desensitize` | disable the system-prompt filter rewrite (to demonstrate the failure) |
| `--no-retry` | disable the block-retry ladder |
| `--expose-identity` | include `nickname` / `uid` in `GET /health` (off by default) |

Environment equivalents: `WORKBUDDY_GATEWAY_PORT`, `WORKBUDDY_GATEWAY_API_KEY`, `WORKBUDDY_GATEWAY_HOST`, `WORKBUDDY_GATEWAY_CONFIG`, `WORKBUDDY_GATEWAY_LOG`, `WORKBUDDY_GATEWAY_DEBUG`, `WORKBUDDY_MODELS`, `WORKBUDDY_UPSTREAM`, `WORKBUDDY_AUTH_FILE`.

> A config file saved by PowerShell 5.1's `Set-Content -Encoding UTF8` or by Notepad begins with a UTF-8 BOM. The gateway strips it; other tools reading the same file may not.

---

## Background and autostart

The setup scripts already start the gateway detached, so nothing further is needed for normal use.

To run it by hand, detached:

```bash
node gateway.js --port 8790 --api-key workbuddy-local --log ./logs/gateway.log --detach
# [workbuddy-gateway] detached, pid 29396 (pid file: ./logs/gateway.pid)
```

Stop it with `taskkill /PID <pid> /T /F` on Windows, `kill <pid>` elsewhere.

To start it **at login**, use the platform's own mechanism rather than a wrapper script:

- **Linux** — a `systemd --user` unit at `~/.config/systemd/user/workbuddy-gateway.service` with
  `ExecStart=/usr/bin/node /path/to/gateway.js --log %h/.workbuddy-gateway/gateway.log`, then
  `systemctl --user enable --now workbuddy-gateway`
- **macOS** — a `launchd` agent in `~/Library/LaunchAgents/` running the same command
- **Windows** — Task Scheduler: trigger "At log on", action
  `node C:\path\to\gateway.js --log C:\path\to\logs\gateway.log`
- **WSL** — a line in `~/.bashrc` calling `wsl/start-gateway.sh`, or a systemd user unit
  (requires systemd enabled in WSL)

---

## Troubleshooting

The full list, with the exact error strings, is in [`docs/troubleshooting.md`](docs/troubleshooting.md). The most common ones:

| Symptom | Cause | Fix |
|---|---|---|
| `no WorkBuddy/CodeBuddy auth file found` | Desktop client not signed in, or the session is somewhere unusual | Sign in, or set `WORKBUDDY_AUTH_FILE` / `authFile` |
| `11128 Illegal API invocation from an unapproved channel` | The content filter matched the agent's own refusal preamble | Should be handled automatically; if not, check that `desensitize` is not disabled |
| `11102 service info not found` | The model id no longer exists upstream | `node probes/probe-models.js` and update your model list |
| Empty answer, `finish_reason: "length"` | `max_tokens` too small for a reasoning model | Raise the budget, or pick a non-reasoning model |
| `401 invalid api key` | Client key ≠ gateway `--api-key` | Make them match |
| `upstream unreachable: fetch failed` | No network, or a system proxy is intercepting `fetch` | Check the proxy settings in the environment the gateway runs in |
| VS Code: no WorkBuddy group in the model picker | The provider registers during activation | Fully restart VS Code; check **Developer: Show Logs… → Extension Host** |
| WSL: `no gateway answered` | A Windows-loopback gateway is unreachable from WSL | Run `bash wsl/start-gateway.sh` inside WSL |
| Gateway works in curl, fails in an agent client | Tool calls answered in prose | The model may not support tools; check `supportsToolCall` for that id |

If it stopped working after being fine, an upstream change is the usual cause — the fix normally lives in `lib/core.js` (request shape) or the model list (`probes/`).

---

## Layout

```
gateway.js                 the server (config, HTTP routes, retry ladder)
lib/core.js                pure logic: desensitization, request building, SSE parsing
lib/credentials.js         session discovery, token refresh, upstream headers
scripts/setup.{ps1,sh}     one-command install
scripts/stop.{ps1,sh}      stop the gateway
wsl/start-gateway.sh       loopback gateway inside WSL (default port 8790)
wsl/stop-gateway.sh        stop it
wsl/install-extension.sh   install the extension into the WSL extension host
vscode-extension/          VS Code integration (model provider + standalone panel)
probes/probe-models.js     which model ids the account really serves
probes/probe-thinking.js   which models emit a reasoning channel
probes/probe-reasoning.js  how the upstream reacts to reasoning_effort
probes/probe-limits.js     which max_tokens values are accepted (weak signal, see file header)
probes/probe-block.js      reproduce the security-filter rejection and verify the fix
tests/unit/                offline unit tests for lib/core.js
tests/smoke-test.js        live end-to-end check against a running gateway
docs/                      DeepSeek Harness, other clients, troubleshooting
```

---

## Security, legal and license

### Security

- Binds `127.0.0.1` by default. **Do not expose it to a network** — whoever can reach the port can spend your account's quota and read your session's output.
- The auth file is equivalent to full control of the account. Keep it out of version control (`.gitignore` already covers `*.info`, `auths/`, `logs/`).
- Logs can contain full prompts and answers. They stay local and are never sent anywhere by this project.
- The only outbound request this project makes is to the configured upstream. No telemetry, no analytics.

### Legal and compliance boundary

This is **unofficial** software. It is not affiliated with, endorsed by, or supported by Tencent, CodeBuddy or WorkBuddy.

- Use it **only with an account you personally own and are authorized to use**, on your own machine or in a private environment.
- Reusing a desktop login session through a proxy may conflict with the upstream platform's terms of service. Account restrictions or bans are possible. **You accept that risk.**
- Do not share, resell, redistribute or publicly host the resulting endpoint, and do not use it to circumvent the upstream's content policy for genuinely harmful input. The desensitization feature exists so that *refusal statements* are not misread as requests, not to smuggle disallowed requests through.
- The software is provided "as is", without warranty of any kind. The authors are not liable for account suspension, data loss, or any other consequence of use.

Upstream protocols and model ids change without notice. If this stops working, the fix usually lives in `lib/core.js` (request shape) or `probes/` (model list).

### License

MIT — see [LICENSE](LICENSE). Third-party credits in [NOTICE](NOTICE).
