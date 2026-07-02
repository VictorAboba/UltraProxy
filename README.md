# UltraProxy

Route **Anthropic / OpenAI** API traffic from a **Remote‑SSH cluster** through a proxy running on
your **local machine** (Windows or Linux), so tools on the cluster — Claude Code CLI, the
`anthropic`/`openai` SDKs, and GitHub Copilot — can reach models that the cluster network blocks.

Your local machine runs an **Xray‑core** client configured from an `ss://` / `ssconf://` / `vless://`
key (the same engine v2rayN uses). The extension opens its **own reverse SSH tunnel** into the
cluster and injects proxy settings there. A strict whitelist guarantees that **only** Anthropic/OpenAI
egress through the proxy — **local‑network models (e.g. vLLM) stay direct.**

```
 Cluster (Remote-SSH)                         Your local machine
┌───────────────────────────┐               ┌──────────────────────────────┐
│ Claude Code / SDK / Copilot│               │  UltraProxy (VS Code, "ui")  │
│   HTTPS_PROXY / http.proxy │               │                              │
│        ↓                   │  reverse SSH  │   Xray-core (SOCKS + HTTP)    │
│  127.0.0.1:<remotePort>  ──┼──── -R ───────┼─► 127.0.0.1:<httpPort>       │
│                            │   tunnel      │        │ whitelist routing    │
│  vLLM / LAN → DIRECT       │               │        ▼ ss:// / vless://     │
└───────────────────────────┘               │   real internet → Anthropic  │
                                             └──────────────────────────────┘
```

## Why it's built this way

- **`extensionKind: ["ui"]`** — the extension runs on your *local* machine even when the VS Code
  window is attached to a Remote‑SSH host. Only the local side has working internet.
- **Whitelist routing** — Xray sends the AI/Copilot domains (`anthropic.com`, `openai.com`,
  `githubcopilot.com`, … + your extras) through the proxy **server**. By default everything else is
  routed `direct` via your local machine, so nothing on the cluster breaks. Set
  `ultraproxy.strictWhitelist` to **block** non‑whitelisted traffic instead.
- **`NO_PROXY` covers the LAN by default** — localhost + **all private ranges** (`10/8`,
  `172.16/12`, `192.168/16`, …) and common package hosts (PyPI, HuggingFace, conda, Docker) are
  excluded from the proxy, so in‑cluster models and big downloads keep using the cluster's own
  internet.
  - **vLLM usually needs NO configuration.** If your vLLM is reachable at a private LAN IP (the
    normal case), it is already bypassed — nothing to set. You only need `ultraproxy.vllmHost` if
    vLLM is reached by a **hostname** that resolves to a private IP (env `NO_PROXY` matches by name,
    not resolved IP), or if you turned on `strictWhitelist`.

## Requirements

- **Local:** VS Code ≥ 1.85, Windows or Linux. Xray is auto‑downloaded on first run (or point
  `ultraproxy.xrayPath` at an existing `xray.exe`, e.g. v2rayN's `bin/xray/xray.exe`).
- **Cluster:** reachable over SSH; `base64` (coreutils) always; `python3` **only** if you want the
  Copilot / VS Code `http.proxy` patch (env‑var injection works without it).

## Setup

1. Install the extension locally (see **Build** below).
2. **Everything is configurable by buttons** — click the **⚙ gear** in the status bar (or run
   **UltraProxy: Configure**) to set the share link, add/edit/remove clusters, credentials, routing,
   vLLM hosts and every option without ever touching `settings.json`. (You can still edit
   `settings.json` directly if you prefer — the keys below.)
   ```jsonc
   {
     "ultraproxy.shareLink": "vless://…  or  ss://…  or  ssconf://…  or  https://sub…",
     "ultraproxy.sshHost": "cluster.example.edu",
     "ultraproxy.sshUser": "myuser",
     "ultraproxy.sshAuthMethod": "agent",        // "agent" | "key" | "password"
     "ultraproxy.sshPrivateKeyPath": "",          // for "key"
     "ultraproxy.vllmHost": ["10.1.2.3", "vllm.internal"]  // never proxied
   }
   ```
3. Secrets never go in `settings.json` — run **UltraProxy: Set SSH / Proxy Credentials** to store the
   SSH password, key passphrase, or (optionally) the share link in VS Code SecretStorage.
4. Run **UltraProxy: Apply Proxy to Remote** (or the status‑bar shield). When prompted, **Reload
   Window** so Copilot on the remote picks up the proxy. Open a **new terminal** for CLI tools.

### SSH auth
Auth falls through **agent → key → password → keyboard‑interactive**, so both password and keyless
setups work. `ultraproxy.sshAuthMethod` just sets the preference. On Windows the OpenSSH agent pipe
(`\\.\pipe\openssh-ssh-agent`) is used automatically.

## Multiple clusters at once

UltraProxy can proxy **several clusters simultaneously**: **one shared local Xray**, one reverse
tunnel per cluster. List them under `ultraproxy.clusters` (any field omitted falls back to the flat
`ultraproxy.ssh*` settings):

```jsonc
{
  "ultraproxy.shareLink": "vless://…",           // one proxy = one exit, shared by all clusters
  "ultraproxy.clusters": [
    { "name": "gpu-a", "host": "a.example.edu", "user": "vic", "authMethod": "agent",
      "vllmHost": ["10.1.0.5:8000"] },
    { "name": "gpu-b", "host": "b.example.edu", "user": "vic", "authMethod": "password",
      "remoteProxyPort": 0 }
  ]
}
```

- **Apply / Remove / Restart / Test** ask whether to act on **all** clusters or **one** (auto‑skipped
  when only one is configured). The status bar shows `active/total` (e.g. `UltraProxy 2/3`).
- **Credentials are per‑cluster** — *Set Credentials* → *SSH password/passphrase* asks which cluster.
- **Per‑cluster `vllmHost`** is merged with the global `NO_PROXY` for that cluster only.
- Since the extension runs **locally** and its tunnels are independent of Remote‑SSH, drive all
  clusters from **one window** (a local, non‑remote VSCode window works well). Each cluster's own
  VSCode window then benefits from the injection — reload that window / open a new terminal there.
- If `ultraproxy.clusters` is empty, the flat `ssh*` settings act as a single cluster (backward
  compatible).

## What gets changed on the cluster

| What | Where | Purpose |
|---|---|---|
| `HTTPS_PROXY` / `NO_PROXY` (+ lowercase, `NODE_USE_ENV_PROXY=1`) | `~/.ultraproxy/env.sh`, sourced from `~/.bashrc` & `~/.profile` (guard line marked `# ULTRAPROXY`) | Claude Code CLI / SDKs |
| `http.proxy`, `http.noProxy`, `terminal.integrated.env.linux` | `~/.vscode-server*/data/Machine/settings.json` (backed up to `*.ultraproxy.bak`) | GitHub Copilot & remote terminals |

All changes are **idempotent** and fully reverted by **UltraProxy: Remove Proxy from Remote**.

## Commands

| Command | Action |
|---|---|
| UltraProxy: Configure | Button-driven editor for **all** settings (share link, clusters, routing, options) |
| UltraProxy: Apply Proxy to Remote | Start Xray, open the tunnel, inject settings |
| UltraProxy: Remove Proxy from Remote | Revert everything on the cluster, stop tunnel & Xray |
| UltraProxy: Restart Proxy & Tunnel | Remove + Apply |
| UltraProxy: Test Connection | Probe Anthropic/OpenAI `/v1/models` from **both** sides; list models if a key is stored |
| UltraProxy: Set SSH / Proxy Credentials | Store SSH password / passphrase / share link **and optional provider API keys** securely |
| UltraProxy: Pick Server from Subscription | Choose a server from an `ssconf`/subscription |
| UltraProxy: Show Log / Show Status | Diagnostics |

Three status‑bar buttons appear at the bottom‑left: the **shield** (`UltraProxy N/M`) opens the
action menu (Apply/Remove/Test/Configure/Log/Credentials), the **⚙ gear** opens the full Configure
UI, and the **`$(output)` icon** opens the log directly.

### Test Connection
Verifies the proxy actually works end‑to‑end:
- **local** — through the local Xray HTTP proxy (proves the `ss`/`vless` outbound reaches the provider);
- **cluster** — `curl` on the cluster through the reverse tunnel (proves the tunnel + injection).

Any HTTP response (e.g. `401` without a key) means the path works. Store an **Anthropic/OpenAI API
key** via *Set Credentials* to also print the real list of available models — the key is used **only
locally** and is never sent to the cluster. Add extra probe URLs with `ultraproxy.testEndpoints`.

## Supported keys

- **`ss://`** — SIP002 (base64 & 2022‑blake3 forms) and the legacy base64 form; `plugin=` is parsed
  (native SS‑2022 recommended; unsupported plugins are warned about).
- **`ssconf://`** — SIP008 online config (swapped to `https://`, TLS verified). Pick a server with
  `ultraproxy.subscriptionServerName` or the *Pick Server* command.
- **`vless://`** — TCP / WS / gRPC / HTTPUpgrade, with **TLS** or **REALITY** (`pbk`/`sid`/`spx`/`fp`,
  `flow=xtls-rprx-vision`). `flow` is dropped automatically over WS.
- **`http(s)://` subscription** — base64 list of the above.

## Known limitations

- **Node SDKs & proxy env:** Node's native `fetch`/`undici` only honor proxy env from **Node ≥ 24**
  (hence `NODE_USE_ENV_PROXY=1`). On Node 18–23 an SDK using native fetch needs an app‑level
  `undici.ProxyAgent`; env vars alone won't route it. The **Claude Code CLI honors the env directly.**
- **`http.useLocalProxyConfiguration` / `http.noProxy`** are newer‑VS Code settings; on older remote
  servers Copilot proxy control is coarser.
- rc files aren't always sourced by non‑login shells — the `terminal.integrated.env.linux` patch is
  the belt‑and‑suspenders for terminal tools.
- With `remoteProxyPort: 0` (default) the cluster port is **auto‑assigned and changes on reconnect**;
  already‑open terminals keep the old value. On a port change after reconnect UltraProxy re‑prompts
  you to reload. Set a fixed `remoteProxyPort` for stability.
- **Non‑AI traffic from a proxied shell:** because `HTTPS_PROXY` is exported globally, a host not in
  the whitelist and not in `NO_PROXY` is tunnelled through your local machine (works, but uses your
  home bandwidth). The default `NO_PROXY` covers PyPI/HuggingFace/conda/Docker/private ranges; add
  more hosts to `ultraproxy.noProxy` to keep them on the cluster's link, or enable
  `strictWhitelist` to block them outright.
- **`allowInsecure` / unverified binaries are opt‑in:** a fetched subscription cannot disable TLS
  verification (`ultraproxy.allowInsecureTls`, default off), and a downloaded Xray binary that fails
  SHA‑256 verification is refused (`ultraproxy.allowUnverifiedBinary`, default off).

## Build

```bash
npm install
npm run compile        # tsc -> out/
npm test               # behavioral self-test
npm run download-xray  # bundle xray binaries into bin/ (win32-x64, linux-x64)
npm run package        # compile + bundle + vsce package -> ultraproxy-0.1.0.vsix
```
`npm run package` produces a **self‑contained** `.vsix` — the `ssh2`/`yauzl` deps and the **Xray
binaries** are bundled inside, so the installed extension **fetches nothing external at runtime**.

- Bundled binaries cover **win32‑x64** and **linux‑x64** (the usual local dev machines). On other
  platforms (macOS, arm64) the extension does a **one‑time** verified download of Xray on first run;
  add those to `XRAY_TARGETS` in the build to bundle them too.
- The build is automated in [CI](.github/workflows/build.yml): every push builds the `.vsix` as an
  artifact; pushing a `vX.Y.Z` tag (matching `package.json`) publishes a GitHub Release with the
  `.vsix` attached.

Install the `.vsix`: Extensions view → `…` → *Install from VSIX…* (install it **locally**, not on the
remote — it is a UI extension and pins itself to the local host).

## Security notes

- Secrets live in SecretStorage; the output log redacts them.
- The forwarded cluster port binds to `127.0.0.1` only (not exposed to other cluster users).
- Binary downloads are SHA‑256‑verified against the release `.dgst`; SIP008/subscription fetches use
  verified TLS.
