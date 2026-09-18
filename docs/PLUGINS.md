# ReMCP plugins

ReMCP is designed to be installed from the plugin catalog of the AI host you already use.

For normal users, the flow is:

1. Find **ReMCP** in the host's plugin browser.
2. Install it.
3. Sign in to ReMCP when the host asks you to connect.
4. Use the computers already paired to your ReMCP account.

You do **not** need to paste an MCP server URL, edit a manifest, clone the repository, or configure a local path just to use the catalog plugin.

Shareable install guides:

- ChatGPT & Codex: <https://remcp.site/install/chatgpt>
- Claude Code: <https://remcp.site/install/claude>

These ReMCP URLs are stable user-facing guides. They can later point to the final catalog card without changing the link you already shared.

## ChatGPT and Codex

ChatGPT and Codex share OpenAI's unified public plugin directory.

### ChatGPT

Open:

```text
https://chatgpt.com/plugins
```

Then:

1. Search for **ReMCP**.
2. Open the ReMCP plugin card.
3. Choose the add/install action.
4. Complete ReMCP OAuth when prompted.
5. Start a new chat and ask ChatGPT to use ReMCP on a paired computer.

OpenAI assigns published plugin cards an opaque detail URL such as
`https://chatgpt.com/plugins/plugin_connector_<id>`. That identifier is created by the platform; it
should not be guessed from the plugin name. Once the ReMCP public listing exposes its final connector
URL, the website can link directly to that card.

### Codex CLI

Run Codex, then open the plugin browser:

```text
/plugins
```

Search for **ReMCP**, open its details, and install it. ChatGPT and Codex use the same public plugin
directory, so there is no separate ReMCP package to configure for Codex.

## Claude Code

ReMCP was submitted to Anthropic on **September 18, 2026** and currently shows **Submitted and
pending review**.

Anthropic publishes accepted third-party plugins through the community marketplace. After ReMCP is
approved, the official Claude Code flow is:

```text
/plugin marketplace add anthropics/claude-plugins-community
/plugin install remcp@claude-community
```

The first command adds Anthropic's community marketplace once. The second installs ReMCP by name.
This is Claude Code's plugin manager flow; users do not clone the ReMCP repository or edit MCP
configuration files.

After installation, complete ReMCP authentication when Claude Code asks you to connect, then use your
paired computers normally.

## What the plugin carries for you

Both host packages already contain the information needed to connect to ReMCP. The end-user install
experience should therefore be described as:

**Install from catalog → sign in to ReMCP → use paired computers.**

The following details are implementation internals, not user setup steps:

- MCP server endpoint;
- host-specific manifest files;
- OAuth metadata URLs;
- review/submission JSON;
- local development commands such as `--plugin-dir`.

## Developer and reviewer documentation

Technical details are intentionally separated from the user install flow:

- [OPENAI_PLUGIN.md](OPENAI_PLUGIN.md) — OpenAI packaging, MCP configuration, reviewer workflow, and submission artifacts.
- [CLAUDE_CODE_PLUGIN.md](CLAUDE_CODE_PLUGIN.md) — Claude Code manifest, validation, local development, and Anthropic submission details.

The two integrations still share the same ReMCP backend, OAuth account boundary, five operational
skills, and paired-device trust model, while keeping host-specific packaging separate.
