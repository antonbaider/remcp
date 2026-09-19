# ReMCP installation for MCP hosts

ReMCP is a hosted remote MCP server. Do not clone or launch a local MCP server process.

## MCP endpoint

Use a Streamable HTTP transport:

```json
{
  "mcpServers": {
    "remcp": {
      "type": "streamableHttp",
      "url": "https://remcp.site/mcp"
    }
  }
}
```

For hosts that spell the transport as `streamable-http`, use that host's documented spelling with the same URL.

## Authentication

ReMCP uses MCP OAuth discovery. When the host reports that authorization is required, complete the browser authorization flow and return to the host. Do not create or paste a static ReMCP API token into the MCP configuration.

## Pair a computer

After signing in, open the ReMCP workspace and use **Connect computer**. Run the generated pairing command on the computer you want the agent to access. The device makes an outbound connection to ReMCP; no inbound port is required.

## Verify

After authorization and pairing:

1. Call `list_devices`.
2. Select the returned device id.
3. Call `ping_device` with that exact id.
4. Use file or terminal tools only on the computer the user explicitly selected.

If no computer is paired yet, `list_devices` returns the current connection instructions.
