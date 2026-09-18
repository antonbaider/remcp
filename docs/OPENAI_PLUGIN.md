# ChatGPT & Codex plugin — OpenAI

ReMCP ships a production OpenAI Plugins package for ChatGPT and Codex. It combines the hosted remote
MCP server with five shared operational skills, review metadata, and two self-contained MCP App
resources for file and image previews.

This is the **OpenAI-specific** package. Claude Code packaging lives beside it and does not replace,
rename, or regenerate the files described here.

## At a glance

| | Value |
| --- | --- |
| Production MCP | `https://remcp.site/mcp` |
| Manifest | `plugin.json` |
| MCP configuration | `mcp.json` |
| Shared skills | 5 |
| Hosted tool surface | 52 tools |
| Rich UI | file preview/editor + image/screenshot preview |
| Authentication | OAuth authorization code + PKCE, OIDC/UserInfo metadata |
| Public overview | [`docs/PLUGINS.md`](PLUGINS.md) |

## Package layout

- `plugin.json` — portable Agent Plugins manifest.
- `mcp.json` — production Streamable HTTP MCP endpoint.
- `skills/` — five skills exported over the MCP skills extension (`skills/list`, `skills/get`,
  `resources/read` with SHA-256 digests): the operator guide, code change and verification,
  process supervision, safe destructive operations, and transfers between machines.
- `assets/remcp-icon.png` — plugin icon/logo.
- `chatgpt-app-submission.json` — generated tool annotations and 5 positive / 3 negative review cases.
- `submission/plugin-form.md` — copy-ready portal values.

## Production endpoints

- Website: `https://remcp.site`
- MCP: `https://remcp.site/mcp`
- OAuth metadata: `https://remcp.site/.well-known/oauth-authorization-server`
- Protected resource metadata: `https://remcp.site/.well-known/oauth-protected-resource/mcp`
- UserInfo: `https://remcp.site/oauth/userinfo`
- Privacy: `https://remcp.site/privacy`
- Terms: `https://remcp.site/terms`
- Support: `https://remcp.site/support`

## Before opening the portal

1. Confirm the publishing OpenAI organization has **Apps Management: Write** and that the project uses **global data residency**; projects with EU data residency cannot submit MCP plugins for review.
2. Complete individual or business verification for the identity shown in the listing.
3. Create a dedicated Firebase Email/Password reviewer identity and mark its email verified. The reviewer signs in at `https://demo.remcp.site/`, or directly in the Email/Password form on the canonical `https://remcp.site/authorize` OAuth screen; no MFA, OTP, magic link, email code, social-provider challenge, or private-network access is required. Do not commit its credentials; enter them only in the OpenAI submission portal.
4. Sign in once with that reviewer identity so the isolated `review-sandbox` fixture is available.
5. Verify OAuth metadata advertises `openid`, `email`, `remcp:control`, `offline_access`, and a `userinfo_endpoint`.
6. Confirm the reviewer account has a verified email so UserInfo can return `email_verified: true`.
7. Put the portal token at `https://remcp.site/.well-known/openai-apps-challenge` and verify it byte-for-byte.
8. In the portal choose **With MCP → Universal**, enter `https://remcp.site/mcp`, configure OAuth, then **Scan Tools**.
9. Let **Scan Tools** import the five skills from the MCP skills extension. If the portal explicitly asks for a bundle instead, upload `submission/remcp-plugin.zip`.
10. Enter the three starter prompts and the 5 positive / 3 negative test cases from `chatgpt-app-submission.json`.
11. Screenshots are optional. If you include them, capture 3 current ChatGPT PNG/JPEG screenshots — one per starter prompt — each exactly 706 px wide and 400–860 px high. Make the set demonstrate both deployed MCP App components (file preview/editor and image/screenshot preview), and use the synthetic `review-sandbox` image whenever the image preview is shown so no private computer screen appears in submission materials.
12. Select only regions where the hosted service, support, privacy policy, and terms are ready.
13. Review the final policy attestations manually and submit for review.

ReMCP has two self-contained plugin UI components. They are served as MCP App resources and use no external assets or network fetches; the portal screenshots should show the deployed ChatGPT rendering, not a mockup.

## Review-sensitive behavior

ReMCP exposes powerful local computer operations. Tool metadata must remain literal and accurate. `start_process` and `interact_with_process` can reach the public internet, so their `openWorldHint` values must remain `true`; `read_file` reads local files only. Mutating and terminating tools must retain accurate destructive hints.

The bundled skill tells the model not to request or process passwords, MFA codes, private keys, payment-card data, protected health information, or government identifiers. Reviewers should use only the seeded review sandbox and non-sensitive fixture data.
