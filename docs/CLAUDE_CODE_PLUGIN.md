# Claude Code plugin — Anthropic

## User install path

ReMCP is currently **Submitted and pending review** in Anthropic's plugin directory.

After approval, the preferred user flow is:

1. Open <https://claude.com/plugins>.
2. Filter for **Claude Code** if needed.
3. Search for **ReMCP**.
4. Choose **Install**.
5. Complete ReMCP OAuth when Claude requests authorization.

Users do **not** need to clone the repository, run `--plugin-dir`, paste an MCP endpoint, or edit
`.mcp.json` for normal catalog installation.

After approval, Claude Code terminal users can install from Anthropic's community marketplace with:

```text
/plugin marketplace add anthropics/claude-plugins-community
/plugin install remcp@claude-community
```

The marketplace is added once per user. The normal Claude Plugins directory remains the preferred visual install path.

### Early access while review is pending

ReMCP also publishes a validated public marketplace for users who need Claude Code access before the
directory listing is approved:

```bash
claude plugin marketplace add antonbaider/remcp
claude plugin install remcp@remcp --scope user
```

Inside an already-open Claude Code session:

```text
/plugin marketplace add antonbaider/remcp
/plugin install remcp@remcp
```

This early-access route uses Claude Code's supported marketplace mechanism. It does not require a
repository clone or a manual MCP endpoint.

The rest of this document is for **developers and reviewers**.

ReMCP ships a native Claude Code plugin alongside the separate OpenAI Plugins package. The two
integrations share the same public skills, production MCP endpoint, OAuth service, and paired-device
model, but use different manifests and validation paths so a change for one ecosystem cannot silently
break the other.

> **Directory status — September 18, 2026:** submitted through Claude Platform and accepted by the
> submission API. Anthropic Console currently shows **Submitted and pending review**. This document
> does not claim community-marketplace availability until Anthropic marks the listing approved.

See [`PLUGINS.md`](PLUGINS.md) for the side-by-side OpenAI / Anthropic overview.

## Files

- `.claude-plugin/plugin.json` — Claude Code plugin metadata.
- `.mcp.json` — Claude Code remote HTTP MCP configuration.
- `skills/*/SKILL.md` — shared ReMCP skills loaded by Claude Code from the plugin root.
- `plugin.json`, `mcp.json`, `chatgpt-app-submission.json` — existing OpenAI/Agent Plugins artifacts; these remain separate and unchanged by the Claude manifest.

The Claude MCP entry uses the recommended remote HTTP transport:

```json
{
  "mcpServers": {
    "remcp": {
      "type": "http",
      "url": "https://remcp.site/mcp"
    }
  }
}
```

Authentication is discovered from the ReMCP MCP endpoint. ReMCP exposes OAuth protected-resource / authorization-server metadata and uses authorization code + PKCE. Do not put access tokens, client secrets, Firebase credentials, or test credentials in the plugin repository.

## Validate

Run the repository-owned compatibility check first:

```bash
npm run claude:check
```

Then validate with the current Claude Code CLI before every Anthropic submission:

```bash
claude plugin validate . --strict
```

For a one-off check without changing the globally installed Claude Code version:

```bash
npx --yes @anthropic-ai/claude-code@latest plugin validate . --strict
```

A successful review candidate must print `Validation passed` (with no warnings when `--strict` is used).

## Local smoke test

From the public ReMCP repository:

```bash
claude --plugin-dir .
```

Then verify that the five ReMCP skills appear under the `remcp:` namespace and that the `remcp` MCP server is listed. Complete the OAuth browser flow when prompted and run a read-only check first, for example listing paired computers.

## Submission status

The public repository was submitted through Claude Platform on **September 18, 2026**:

```text
https://github.com/antonbaider/remcp
```

Anthropic accepted the submission and currently reports **Submitted and pending review**. The plugin
root is the repository root. The candidate passed both the repository-owned contract check and
`claude plugin validate . --strict` before submission.

Until Anthropic marks the directory entry approved, the public ReMCP marketplace above is the supported
user early-access path. The local `--plugin-dir` flow is for development and smoke testing only.

When the directory listing is live, promote the directory Install button as the primary user path and
keep the ReMCP marketplace as an optional advanced fallback.

## Release safety

The private `remcp-full` repository remains the source of truth. `scripts/build-public-repo.mjs` exports the Claude files to the public repository in addition to the existing OpenAI artifacts. The exporter does not rename or replace the OpenAI manifests.

Before publishing:

```bash
npm run claude:check
npm run release:check
npm run public:check -- --target /path/to/public/remcp
npm test
```

Do not merge a Claude packaging change when any existing OpenAI release check regresses.
