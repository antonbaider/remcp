# Security Policy

ReMCP provides remote access to paired computers through MCP. Treat every ReMCP deployment as privileged infrastructure.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities that could expose credentials, authentication bypasses, cross-tenant access, remote command execution outside the intended tool boundary, or sensitive device data.

Report security issues privately to the project maintainer through GitHub's private vulnerability reporting for this repository when available.

Include the affected version, a concise reproduction, expected versus observed behavior, and any relevant logs with credentials removed.

## Supported versions

Security fixes are applied to the latest released version. Users should update both the central server and device agent when a security release is published.

## Operational guidance

Use HTTPS/WSS, keep device credentials private, revoke devices that are lost or retired, and review mutating MCP actions before approval. Never commit `.env` files, OAuth tokens, Firebase Admin private keys, or device credentials.