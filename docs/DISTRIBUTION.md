# ReMCP distribution

ReMCP keeps one public source repository and publishes host-native discovery metadata for each supported ecosystem.

## User-facing distribution

| Host / catalog | Discovery / install path | Status |
| --- | --- | --- |
| ChatGPT & Codex | OpenAI plugin directory | submitted / platform-controlled rollout |
| Claude Code | Claude Plugins directory | submitted, pending review |
| Cursor | Cursor Marketplace | submission prepared from root Agent Plugin |
| Gemini CLI | Gemini CLI Extension Gallery | auto-indexed after the public repository carries the `gemini-cli-extension` GitHub topic |
| GitHub Copilot CLI | Awesome Copilot default marketplace + ReMCP marketplace fallback | external submission |
| VS Code Agent Plugins | Awesome Copilot default marketplace + install from source | same Agent Plugin package |
| Official MCP Registry | registry.modelcontextprotocol.io | remote Streamable HTTP server |

For ordinary users, the product flow is always:

**Find ReMCP in the host → Install → sign in to ReMCP → use paired computers.**

The production MCP URL and host-specific manifests are implementation details, not normal installation steps.

## Portable core

The root `plugin.json` is Agent Plugins 1.0 and the root `mcp.json` contains the portable remote MCP definition. Cursor, GitHub Copilot, and VS Code can consume that package directly.

Gemini CLI requires `gemini-extension.json`. The extension uses `httpUrl` for the remote Streamable HTTP MCP endpoint with OAuth dynamic discovery, so users do not paste tokens or endpoint URLs. For gallery discovery, the public GitHub repository must also carry the `gemini-cli-extension` topic.

The Official MCP Registry uses `server.json` with the GitHub-authenticated name `io.github.antonbaider/remcp` and the public production remote.

GitHub Copilot CLI and VS Code can also register this repository as a marketplace through `.github/plugin/marketplace.json` while the Awesome Copilot listing is under review.

## Validation

Run the repository-owned cross-distribution check:

```bash
npm run distribution:check
```

Then run the host-native validators when preparing a distribution change:

```bash
npx --yes @google/gemini-cli@latest extensions validate .
mcp-publisher validate server.json
```

Cursor, Copilot, and VS Code use the root Agent Plugins 1.0 package, which is covered by `npm run plugin:check` and the public marketplace review pipelines.

## Release rule

All distribution manifests carry the same ReMCP version and production MCP endpoint. `npm run release:prepare` synchronizes their version fields. A release must not update one host while leaving another manifest stale.
