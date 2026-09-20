import process from 'node:process';
import { toolDefinitions, TEXT_OUTPUT_SCHEMA } from './catalog.mjs';
import { advertisedExtendedTools, extendedToolDefinitions } from './extended/catalog.mjs';
import { invokeTool } from './invoke.mjs';

const DEFAULT_CAPABILITY_POLL_MS = 3000;

function pollIntervalMs() {
  const requested = Number(process.env.REMCP_CAPABILITY_POLL_MS);
  return Math.min(60_000, Math.max(250, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CAPABILITY_POLL_MS));
}

function toolConfig(definition, fromJsonSchema) {
  return {
    title: definition.title,
    description: definition.description,
    inputSchema: fromJsonSchema(definition.inputSchema || { type: 'object' }),
    outputSchema: fromJsonSchema(definition.outputSchema || TEXT_OUTPUT_SCHEMA),
    annotations: definition.annotations,
  };
}

export async function startRuntimeMcpServer({ version, instructions, onError = () => {} } = {}) {
  const [{ McpServer, fromJsonSchema }, { serveStdio }] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
  ]);

  const initiallySupported = new Set((await advertisedExtendedTools()).map(tool => tool.name));
  let activeServer = null;
  let capabilityTimer = null;
  let closed = false;

  const serverHandle = serveStdio(() => {
    const server = new McpServer(
      { name: 'remcp-runtime', version },
      {
        capabilities: {
          tools: { listChanged: true },
          experimental: { 'remcp/telemetry': { version: 1, optOut: true } },
        },
        instructions,
        cacheHints: {
          'tools/list': { ttlMs: 1500, cacheScope: 'private' },
          'server/discover': { ttlMs: 3000, cacheScope: 'private' },
        },
      },
    );
    activeServer = server;

    const registrations = new Map();
    for (const definition of [...toolDefinitions, ...extendedToolDefinitions]) {
      const registered = server.registerTool(
        definition.name,
        toolConfig(definition, fromJsonSchema),
        async (args, context) => invokeTool(definition.name, args || {}, { signal: context?.mcpReq?.signal }),
      );
      registrations.set(definition.name, registered);
      if (extendedToolDefinitions.includes(definition) && !initiallySupported.has(definition.name)) registered.disable();
    }

    let lastSupported = initiallySupported;
    capabilityTimer = setInterval(async () => {
      if (closed) return;
      try {
        const next = new Set((await advertisedExtendedTools()).map(tool => tool.name));
        for (const definition of extendedToolDefinitions) {
          const before = lastSupported.has(definition.name);
          const after = next.has(definition.name);
          if (before === after) continue;
          const registered = registrations.get(definition.name);
          if (after) registered?.enable();
          else registered?.disable();
        }
        lastSupported = next;
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }, pollIntervalMs());
    capabilityTimer.unref?.();

    return server;
  }, {
    legacy: 'serve',
    onerror(error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    },
  });

  return {
    async notification(notification) {
      if (!activeServer) return;
      await activeServer.server.notification(notification);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (capabilityTimer) clearInterval(capabilityTimer);
      capabilityTimer = null;
      await serverHandle.close();
      activeServer = null;
    },
  };
}
