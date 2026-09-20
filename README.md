<p align="center">
  <img src="./assets/remcp-icon.png" width="168" alt="ReMCP logo">
</p>

<h1 align="center">ReMCP</h1>

<p align="center"><strong>Your computer. Your tools. One secure MCP connection.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@remcp/remcp"><img alt="npm" src="https://img.shields.io/npm/v/%40remcp%2Fremcp?style=flat-square&label=npm"></a>
  <a href="https://www.npmjs.com/package/@remcp/runtime"><img alt="runtime" src="https://img.shields.io/npm/v/%40remcp%2Fruntime?style=flat-square&label=runtime"></a>
  <a href="https://www.npmjs.com/package/@remcp/remcp"><img alt="downloads" src="https://img.shields.io/npm/dm/%40remcp%2Fremcp?style=flat-square&label=downloads"></a>
  <img alt="Node.js" src="https://img.shields.io/node/v/%40remcp/remcp?style=flat-square&label=node">
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40remcp%2Fremcp?style=flat-square"></a>
  <a href="https://github.com/antonbaider/remcp/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/antonbaider/remcp?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://remcp.site">Website</a> ·
  <a href="https://remcp.site/plugins">Plugins</a> ·
  <a href="https://remcp.site/docs">Docs</a> ·
  <a href="https://remcp.site/security">Security</a> ·
  <a href="https://remcp.site/privacy">Privacy</a> ·
  <a href="https://remcp.site/support">Support</a>
</p>

ReMCP connects a computer you own or administer to **ChatGPT & Codex, Cursor, Claude Code, Gemini
CLI, Kiro, Cline, or another MCP client**. The device agent makes an **outbound connection only** — no
inbound port, no tunnel, no third-party desktop relay. This repository contains the public device
client/runtime, portable Agent Plugin metadata, the Gemini CLI extension manifest, official MCP
Registry metadata, and the host-specific OpenAI and Anthropic plugin packaging.

## Packages

| Package | What it is |
| --- | --- |
| [`@remcp/remcp`](packages/client) | The device client: pairing, the outbound agent, the background service, and the usage-metrics switch. |
| [`@remcp/runtime`](packages/runtime) | The first-party local runtime: **83 MCP tools** for files, images, binary transfer, archives, screenshots, search, terminal/process work, native desktop UI, loopback browser CDP, diagnostics, lightweight documents, and narrowly scoped runtime preferences, with **two direct dependencies**. |

## Install

**Requires Node.js 22.5 or newer.**

```bash
npm install --global @remcp/remcp@latest
```

Then open **[ReMCP → Connect a machine](https://remcp.site/app/connect)** and generate a
one-time pairing command. Run that exact command on the computer you want to connect; it installs the
runtime and registers the background service.

> Pairing codes are generated in the authenticated workspace, expire automatically, and are
> single-use. Do not invent or reuse a code from documentation.

## Commands

| Command | Purpose |
| --- | --- |
| `remcp start` | Start the device agent when no managed background service is already running |
| `remcp status` | Show device, client/runtime versions, managed-agent state, update consistency and server reachability as JSON |
| `remcp doctor` | Status plus a real local-runtime handshake and filesystem diagnostics |
| `remcp install` | Install or repair the persistent user service |
| `remcp update` | Update the client and runtime, then restart the service |
| `remcp uninstall` | Stop and remove the user service |
| `remcp uninstall --purge` | Remove the service and the global packages |
| `remcp telemetry [status\|on\|off]` | Show or change usage metrics for the client **and** the runtime |
| `remcp godmode [status\|on\|off]` | Show or change this computer's local unrestricted mode |
| `remcp --version` | Print the installed client version |

## Plugins

For users, ReMCP is **catalog-first**:

**Install from your AI host → sign in to ReMCP → use your paired computers.**

You do not need to paste an MCP server URL, edit a manifest, clone this repository, or configure a
local path just to use the published plugin.

Shareable install guides:

- ChatGPT & Codex: <https://remcp.site/install/chatgpt>
- Claude Code: <https://remcp.site/install/claude>

### ChatGPT & Codex / OpenAI

ChatGPT and Codex share OpenAI's public plugin directory.

1. Open <https://chatgpt.com/plugins>.
2. Search for **ReMCP** and open the ReMCP plugin card when it is available.
3. Choose **Install plugin**.
4. If prompted, choose **Connect** and complete ReMCP OAuth.
5. In ChatGPT, use **@ReMCP** when you want to invoke it explicitly. In Codex, use **Sources → Use plugins → ReMCP**.

If ReMCP is not visible yet, the listing or rollout is not available to that account. There is no
manual MCP endpoint an ordinary plugin user needs to configure while waiting.

### Claude Code / Anthropic

ReMCP was submitted through Claude Platform on **September 18, 2026** and currently shows
**Submitted and pending review**.

After approval:

1. Open <https://claude.com/plugins>. In Claude or Claude Desktop, you can also use **Customize → Plugins → + → Browse plugins**.
2. Search for **ReMCP** and confirm it supports Claude Code.
3. Choose **Install**.
4. Complete ReMCP authorization if Claude asks you to connect.
5. Ask Claude Code to use ReMCP on a computer already paired to your account.

While the listing is under review, ordinary users do not need to add a marketplace, clone this
repository, or paste an MCP endpoint. Developer and reviewer workflows live in the technical guide.

Start with [**Plugin overview →**](docs/PLUGINS.md).

### Cursor and the wider MCP ecosystem

ReMCP publishes host-native metadata for coding agents plus directory records for MCP discovery:

| Host / directory | User path | Status |
| --- | --- | --- |
| **Cursor** | Find **ReMCP** in Cursor Marketplace and install it. | published |
| **Gemini CLI** | Install from the Extension Gallery when indexed, or run `gemini extensions install https://github.com/antonbaider/remcp`. | gallery discovery enabled |
| **GitHub Copilot CLI** | Install from the `awesome-copilot` default marketplace after external-plugin review. | submitted |
| **VS Code Agent Plugins** | Browse `@agentPlugins` / **Chat: Plugins** after the same Awesome Copilot listing is accepted. | submitted |
| **Kiro Powers** | Import `https://github.com/antonbaider/remcp` from **Add Custom Power → Import power from GitHub** while the curated listing is reviewed. | submitted |
| **Cline** | Use the Cline MCP Marketplace after review; the submission is tracked publicly. | submitted |
| **Smithery** | Open <https://smithery.ai/servers/antonbaider/remcp>. | published |
| **Glama** | Open <https://glama.ai/mcp/servers/antonbaider/remcp>. | listed |
| **Official MCP Registry** | Search for `io.github.antonbaider/remcp` in registry-aware clients. | published |

The same ReMCP OAuth account and paired computers sit behind every route. Marketplace and directory
surfaces change discovery; they do not create separate ReMCP backends.

Distribution manifests, direct install commands, and review links are documented in
[**PLUGINS.md →**](docs/PLUGINS.md) and [**DISTRIBUTION.md →**](docs/DISTRIBUTION.md).

### Developer / reviewer internals

Host-specific manifests, MCP configuration, validation commands, submission artifacts, and local
development workflows remain documented separately:

- [**ChatGPT & Codex developer guide →**](docs/OPENAI_PLUGIN.md)
- [**Claude Code developer guide →**](docs/CLAUDE_CODE_PLUGIN.md)
- [**AI tool-selection evaluation →**](docs/TOOL_SELECTION_EVAL.md)

The OpenAI files and Claude files deliberately do not overwrite each other. Release checks fail if
either host-specific contract drifts from the shared ReMCP version or production endpoint.

## The local runtime

`@remcp/runtime` is a clean-room MCP server written for ReMCP. It is not a fork of, and shares no code
with, [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) or any other MCP
server.

**83 tools:**

| Area | Tools |
| --- | --- |
| Read | `read_file`, `read_files` (glob), `read_multiple_files`, `read_image`, `read_binary`, `list_directory`, `get_file_info`, `hash_file`, `diff_files` |
| Write / edit | `write_file`, `write_files` (bulk), `write_binary`, `apply_patch`, `set_permissions`, `edit_block`, `replace_lines`, `replace_in_files` |
| Organise | `create_directory` (bulk), `move_file`, `copy_file`, `copy_paths`, `move_paths`, `move_to_trash`, `create_archive`, `extract_archive` |
| Delete | `delete_path`, `delete_paths` |
| Transfer | `read_binary` and `write_binary` move any file in base64 chunks both ways; `create_archive` and `extract_archive` move whole trees |
| Screen | `take_screenshot` returns the desktop as an image |
| Search | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Processes | `start_process`, `read_process_output`, `wait_for_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Runtime | `get_system_info`, `get_runtime_info`, `get_runtime_stats`, `set_config_value` |
| Computer use | `computer_snapshot`, `computer_action`, `list_windows`, `window_action`, `launch_app`, `ui_snapshot`, `ui_find`, `ui_action`, `type_text`, `keyboard`, `pointer`, `drag_drop`, `scroll`, `wait_for_ui`, `clipboard`, `display_inventory`, `screenshot_region`, `open_path`, `reveal_path`, `notification` |
| Browser | `browser_tabs`, `browser_navigate`, `browser_snapshot`, `browser_find`, `browser_action`, `browser_wait`, `browser_evaluate` |
| Diagnostics | `service`, `event_log`, `network`, `installed_apps`, `environment`, `audio`, `power_action`, `record_screen` |
| Documents | `read_document`, `edit_spreadsheet`, `edit_document`, `pdf_action` |

The hosted ReMCP endpoint adds eight account tools to the 83 device tools, for a **91-tool default native-first catalog**. ChatGPT receives standard MCP text/structured results and native MCP image content; custom file/image/terminal widgets are not advertised by default. An operator can explicitly enable the three optional presentation-only MCP Apps, but they appear only for clients that negotiate `io.modelcontextprotocol/ui`, producing a 94-tool UI mode. Each online device returned by `list_devices` also reports its live supported subset; platform-specific tools that are unavailable on that computer fail closed rather than being guessed.

### Tool selection for AI agents

ReMCP publishes selection-oriented descriptions and ships the same decision tree in its operator skill:

`native Accessibility/UI Automation → browser DOM/CDP → OCR → coordinates`

- Start unfamiliar desktop work with `computer_snapshot`; use `ui_snapshot/ui_find/ui_action` for native apps.
- For Chromium page content use `browser_navigate action=new_tab` when needed, then `browser_snapshot/browser_find/browser_action/browser_wait` instead of desktop coordinates.
- Use `type_text` for normal Unicode text in native/focused controls, `browser_action` for Chromium page DOM text, and `keyboard` for shortcuts/navigation keys.
- Use `pointer` only when semantic actions cannot express the task; prefer element ids for `drag_drop`. GNOME Wayland drag uses the consent-backed Remote Desktop portal rather than unreliable XTEST drag.
- Use `wait_for_ui` / `browser_wait` instead of fixed sleeps.
- Use `screenshot_region` for targeted visual proof and `record_screen` only for motion/timing.
- Use structured document tools instead of automating Office when the request is about file content.

All 39 computer/browser/diagnostic/document tools declare closed top-level input schemas, parameter descriptions, structured output schemas, and MCP read-only/destructive/idempotent/open-world hints.

**Why the tool list looks different from other computer-control servers.** Security-sensitive
configuration remains deliberately narrow, and everything else the alternatives can do has an
equivalent here — usually more than one:

| Not included | Why |
| --- | --- |
| Bundled browser/document rendering stacks | ReMCP supports lightweight DOCX/XLSX/PDF operations but deliberately uses OOXML and existing system PDF utilities instead of bundling Puppeteer, `sharp`, `exceljs`, or Chromium. |
| Broad configuration mutation | `set_config_value` can change only telemetry and context/output preferences. Access roots, blocked commands, command policy, shell, write limit and unrestricted mode stay local to the computer. |
| URL fetching in `read_file` | It is a server-side request forgery surface. The runtime reads your computer, not the internet. |

**What ReMCP adds beyond the usual set:** image reads and screenshots that any MCP client can
display, binary transfer in both directions, archive create/extract, `wait_for_process_output` instead
of polling, line-range replacement, project-wide replace, unified diffs, checksums, trash instead of
deletion, and host resource reporting.

**Nothing is gated.** There is no approval prompt, no "are you sure", and no mandatory dry run: a tool
call executes with the full rights of the account running the agent — the same trust model as SSH.
Writes replace by default and moves/copies replace the destination. The catastrophic-command
guardrail defaults to `warn` (advisory, not blocking); an operator may choose `allow` or `block`.
Files are never written to a local history log, so tool arguments and output are not recorded there.

## Unrestricted by design

- **No per-call approval contour.** ReMCP does not add a confirmation dialog before each tool call.
  The local runtime's configured roots, command blocklist and command policy still apply, as do the
  operating-system permissions of the account running the agent. Within those boundaries,
  `start_process` can operate services, packages, databases, containers, `sudo`, git, and other local tools.
- **Full transfer in both directions.** `read_binary`/`write_binary` move any file, `create_archive`
  and `extract_archive` move whole trees, and `take_screenshot` shows the desktop.
- **Optional hardening, explicit security boundaries.** `remcp godmode on` lifts the roots, the
  blocklist and the command guardrail for one computer — and only a person at that computer can turn
  it on; no MCP tool accepts it. `allowedRoots` and `blockedCommands` are empty until an operator
  configures them. `dangerousCommands` defaults to `warn`: matching catastrophic commands still
  run, but the result carries an advisory note; `allow` silences it and `block` refuses it. The
  runtime refuses to start — loudly — if `runtime.json` cannot be parsed, so configured safety
  boundaries are never silently dropped.
- **Crash-resistant.** A bad shell, a closed stdin, or a 40 MB line cannot take the runtime down; the
  agent restarts it if it exits, so a device recovers instead of going quietly offline.
- **Outbound-only.** Per-device revocable credential, hashed server-side, stored locally with
  restrictive permissions. Runtime metadata from a custom server requires an explicit
  `--trust-runtime` decision.
- **No local history.** Tool arguments and outputs are never written to a log on your computer.

## Usage metrics

Both the client and the runtime collect **opt-out** usage metrics: tool names, durations, outcomes,
coarse error classes, session counts, and device health samples. They never include file paths, file
contents, command strings, tool arguments, or tool output — the event schema is a whitelist, so those
fields have nowhere to travel.

There is no telemetry endpoint and no third-party processor. The runtime emits MCP notifications to
the agent, and the agent forwards them over the authenticated WebSocket it already holds to **your**
ReMCP account. No install ping, no postinstall script, no remote feature flags, no A/B assignment.

```bash
remcp telemetry off      # one switch for the client and the runtime
remcp telemetry status
```

## Development

```bash
npm install
npm run check
npm test
```

Both workspaces are plain ESM with no build step. The contract commands (`--help`, `--version`,
`--print-tools`, `--describe`) work with no dependencies installed, so CI can diff the advertised
tool surface against the published tarball.

## License

MIT.
