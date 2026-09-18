# Claude Code plugin

ReMCP ships a Claude Code plugin alongside the existing OpenAI/Agent Plugins package. The two integrations share the same public skills and production MCP endpoint, but use separate manifests so changes for one ecosystem cannot silently change the other.

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

## Submission

Anthropic accepts third-party Claude Code plugins through the community marketplace review flow:

- Console (individual authors): <https://platform.claude.com/plugins/submit>
- claude.ai organization form (Team/Enterprise): <https://claude.ai/admin-settings/directory/submissions/plugins/new>

Submit the public repository:

```text
https://github.com/antonbaider/remcp
```

The plugin root is the repository root. Anthropic's review pipeline runs the same `claude plugin validate` check plus automated safety screening. Approved third-party plugins are pinned to a commit in the `anthropics/claude-plugins-community` catalog.

After approval, users can add the community marketplace and install ReMCP:

```bash
claude plugin marketplace add anthropics/claude-plugins-community
claude plugin install remcp@claude-community
```

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
