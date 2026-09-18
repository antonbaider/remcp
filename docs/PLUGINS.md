# ReMCP plugins

ReMCP publishes two host-specific plugin integrations from the same public repository. They share the same production MCP service, OAuth boundary, paired-device model, and five operational skills, but each host gets its own manifest and validation path.

| Integration | Host | Manifest | MCP configuration | Current state |
| --- | --- | --- | --- | --- |
| **ChatGPT & Codex plugin** | OpenAI | `plugin.json` | `mcp.json` | production package and submission artifacts |
| **Claude Code plugin** | Anthropic | `.claude-plugin/plugin.json` | `.mcp.json` | submitted to Anthropic on 2026-09-18; pending directory review |

Both integrations connect to:

```text
https://remcp.site/mcp
```

Authentication is handled by the hosted ReMCP OAuth/OIDC service. The public repository does not contain reusable access tokens, client secrets, reviewer credentials, Firebase secrets, or device credentials.

## ChatGPT & Codex / OpenAI

The OpenAI package is intentionally self-contained:

- `plugin.json` — OpenAI Agent Plugins manifest;
- `mcp.json` — production Streamable HTTP MCP endpoint;
- `skills/*` — five shared operational skills;
- `chatgpt-app-submission.json` — generated tool-review metadata and test cases;
- `submission/remcp-plugin.zip` and `submission/remcp-skills-only.zip` — release-checked portal archives;
- two MCP App resources — file preview/editor and image/screenshot preview.

Read [OPENAI_PLUGIN.md](OPENAI_PLUGIN.md) for packaging, OAuth, reviewer access, Scan Tools, UI evidence, and submission details.

## Claude Code / Anthropic

The Claude Code package is additive and does not replace OpenAI files:

- `.claude-plugin/plugin.json` — Claude plugin identity and marketplace metadata;
- `.mcp.json` — remote HTTP MCP configuration;
- `skills/*` — the same five skills, namespaced by Claude Code under `remcp:`.

Local validation:

```bash
npm run claude:check
claude plugin validate . --strict
claude --plugin-dir .
```

ReMCP was submitted through Claude Platform on **September 18, 2026**. Anthropic accepted the submission and the Console currently reports **Submitted and pending review**. Until directory approval, use `--plugin-dir` for local development/testing rather than documenting the community marketplace command as already available.

Read [CLAUDE_CODE_PLUGIN.md](CLAUDE_CODE_PLUGIN.md) for the complete Claude-specific workflow.

## Why the manifests stay separate

OpenAI and Anthropic use different plugin schemas and lifecycle rules. ReMCP does not try to generate one host manifest from the other. Release checks enforce that:

- OpenAI `plugin.json`, `mcp.json`, review JSON, and ZIP archives keep their own contract;
- Claude `.claude-plugin/plugin.json` and `.mcp.json` keep their own contract;
- the package version is synchronized across release metadata;
- the five shared skills and production MCP endpoint remain aligned;
- existing OpenAI release checks must stay green when Claude packaging changes, and vice versa.

This keeps one backend and one skill set without making either ecosystem depend on the other's packaging format.
