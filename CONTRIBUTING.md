# Contributing to ReMCP

ReMCP is a security-sensitive remote MCP bridge. Keep changes small, auditable, and explicit about side effects.

## Local checks

```bash
npm ci
npm run check
npm test
npm audit --omit=dev
npm pack --dry-run
```

For server changes, also build the production image:

```bash
docker build -t remcp:test .
```

## Security-sensitive changes

Do not commit credentials, `.env` files, OAuth tokens, device tokens, Firebase Admin keys, reviewer credentials, or private host details. Preserve tenant isolation, PKCE, rotating refresh tokens, revocable device credentials, and accurate MCP annotations.

Report vulnerabilities privately as described in `SECURITY.md`.
