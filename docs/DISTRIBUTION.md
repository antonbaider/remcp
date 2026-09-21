# ReMCP distribution

ReMCP keeps one public source repository and publishes host-native discovery metadata for each supported ecosystem.

## User-facing distribution

| Host / catalog | Discovery / install path | Status |
| --- | --- | --- |
| ChatGPT & Codex | OpenAI plugin directory | submitted / platform-controlled rollout |
| Claude Code | Claude Plugins directory | submitted, pending review |
| Cursor | Cursor Marketplace | published |
| Gemini CLI | Gemini CLI Extension Gallery + direct GitHub install | gallery discovery enabled; native extension validated |
| GitHub Copilot CLI | Awesome Copilot default marketplace | external submission under review |
| VS Code Agent Plugins | Awesome Copilot / `@agentPlugins` | same external submission and Agent Plugins 1.0 package |
| Kiro Powers | Kiro Powers registry + direct GitHub import | submitted September 19, 2026; pending review |
| Cline | Cline MCP Marketplace ([PR #125](https://github.com/cline/marketplace/pull/125)) | submitted in current `cline/marketplace`; pending review |
| Smithery | smithery.ai/servers/antonbaider/remcp | published |
| Glama | glama.ai/mcp/connectors/site.remcp/re-mcp | verified / healthy |
| Official MCP Registry | registry.modelcontextprotocol.io | published remote Streamable HTTP server |

For ordinary users, the product flow is always:

**Find ReMCP in the host → Install → sign in to ReMCP → use paired computers.**

The production MCP URL and host-specific manifests are implementation details, not normal installation steps.

Every host reaches the same capability-aware ReMCP tool contract. Hosted `remcp.site` discovery exposes the stable release catalog so installation-time schema caching cannot hide newer tools; the selected computer is still checked against its live runtime capabilities before dispatch. Local runtimes remain dynamic and emit `tools/list_changed` when their own available set changes. See the [full generated tool contract](TOOLS.md) for all 83 device tools, the 8 default account/fleet tools, schemas, and safety hints.

## Portable core

The root `plugin.json` is the canonical Agent Plugins 1.0 manifest and the root `mcp.json` contains the portable remote MCP definition. OpenAI/Codex workspace imports can discover this same root package through `.agents/plugins/marketplace.json`; the Claude-compatible `.claude-plugin/marketplace.json` remains alongside it for hosts that read that format. Cursor, GitHub Copilot, VS Code, and Kiro can consume the portable package directly.

Gemini CLI requires `gemini-extension.json`. The extension uses `httpUrl` for the remote Streamable HTTP MCP endpoint with OAuth dynamic discovery, so users do not paste tokens or endpoint URLs. For gallery discovery, the public GitHub repository must also carry the `gemini-cli-extension` topic.

The Official MCP Registry currently serves the production remote under the legacy GitHub-authenticated identity `io.github.antonbaider/remcp`. After the public repository transfer to `getremcp/remcp`, `server.json` targets `io.github.getremcp/remcp`; the Registry keeps remote URLs unique, so publication under the new identity is intentionally skipped until the legacy record is migrated or removed by Registry maintainers. Manual `workflow_dispatch` runs are validation-only and never publish Registry metadata.

OpenAI/Codex local or workspace marketplace discovery uses `.agents/plugins/marketplace.json` with a structured local source pointing at the repository root. Claude-compatible hosts can use `.claude-plugin/marketplace.json`. GitHub Copilot CLI and VS Code can also register this repository through `.github/plugin/marketplace.json` while the Awesome Copilot listing is under review.

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

Cursor, Copilot, VS Code, and Kiro use the root Agent Plugins 1.0 package, which is covered by `npm run plugin:check` and the public marketplace review pipelines.

## Release rule

All distribution manifests carry the same ReMCP version and production MCP endpoint. `npm run release:prepare` synchronizes their version fields. A release must not update one host while leaving another manifest stale.
