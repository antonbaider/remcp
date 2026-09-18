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

Open the directory with the ReMCP search prefilled:

```text
https://chatgpt.com/plugins?q=ReMCP
```

Then:

1. Open the ReMCP plugin card when it is available for your account.
2. Choose **Install plugin**.
3. Choose **Connect** if ReMCP authorization is requested.
4. Complete ReMCP OAuth.
5. Start a new chat and ask ChatGPT to use ReMCP on a paired computer.

If ReMCP is not visible yet, the listing or rollout is not available to that account. Do not paste an
MCP endpoint or create a manual connection as a substitute for the catalog plugin.

### Codex

In a supported Codex task view:

1. Open **Sources**.
2. Choose **Use plugins**.
3. Search for and select the installed **ReMCP** plugin.

ChatGPT and Codex use the same public plugin directory, so there is no separate ReMCP package or MCP
endpoint for users to configure.

## Claude Code

ReMCP was submitted to Anthropic on **September 18, 2026** and currently shows **Submitted and
pending review**.

After approval, the preferred user flow is:

1. Open <https://claude.com/plugins>.
2. Filter for **Claude Code** if needed.
3. Search for **ReMCP**.
4. Choose **Install**.
5. Complete ReMCP authentication when Claude Code asks you to connect.

Users do not clone the ReMCP repository or edit MCP configuration files.

For Claude Code users who prefer the terminal after approval, Anthropic's community marketplace uses:

```text
/plugin marketplace add anthropics/claude-plugins-community
/plugin install remcp@claude-community
```

### Early access while directory review is pending

Claude Code supports developer-hosted marketplaces. ReMCP publishes a validated public marketplace
for users who need access before Anthropic publishes the directory listing:

```bash
claude plugin marketplace add antonbaider/remcp
claude plugin install remcp@remcp --scope user
```

Inside an already-open Claude Code session:

```text
/plugin marketplace add antonbaider/remcp
/plugin install remcp@remcp
```

This early-access route uses Claude Code's supported marketplace mechanism; it does not require
`git clone`, `--plugin-dir`, or a manual MCP endpoint. Once the directory listing is live, the
regular Install button is the preferred path.

## Cursor, Gemini CLI, GitHub Copilot and VS Code

The same public ReMCP repository is prepared for the other major coding harnesses.

- **Cursor:** ReMCP uses the portable Agent Plugins 1.0 format. Users install the ReMCP catalog entry; the MCP server and five skills come with it.
- **Gemini CLI:** ReMCP publishes a native `gemini-extension.json`. The Extension Gallery can index the public repository and OAuth is discovered automatically.
- **GitHub Copilot CLI:** ReMCP publishes a Copilot marketplace plus the same portable Agent Plugin. Users can install the default-marketplace listing once approved.
- **VS Code Agent Plugins:** VS Code consumes the same Agent Plugins 1.0 package and marketplace metadata.
- **Official MCP Registry:** ReMCP publishes a remote server record for registry-aware MCP clients.

For normal users, none of these paths require copying the underlying MCP URL. Find **ReMCP**, install it, authenticate, and use your paired computers.

See [DISTRIBUTION.md](DISTRIBUTION.md) for marketplace manifests, validation, and submission status.

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
