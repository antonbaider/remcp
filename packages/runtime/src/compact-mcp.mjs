import { compactRuntimeToolDefinitions, resolveCompactRuntimeCall } from './compact-catalog.mjs';
import { invokeTool } from './invoke.mjs';

function toolConfig(definition, fromJsonSchema) {
  return {
    title:definition.title,
    description:definition.description,
    inputSchema:fromJsonSchema(definition.inputSchema || { type:'object' }),
    ...(definition.outputSchema ? { outputSchema:fromJsonSchema(definition.outputSchema) } : {}),
    annotations:definition.annotations,
  };
}

export async function startCompactRuntimeMcpServer({ version, instructions, onError = () => {} } = {}) {
  const [{ McpServer, fromJsonSchema }, { serveStdio }] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
  ]);
  const definitions = await compactRuntimeToolDefinitions();
  let activeServer = null;
  let closed = false;

  const serverHandle = serveStdio(() => {
    const server = new McpServer(
      { name:'remcp-runtime-compact', version },
      {
        capabilities:{ tools:{} },
        instructions,
        cacheHints:{
          'tools/list':{ ttlMs:3000, cacheScope:'private' },
          'server/discover':{ ttlMs:3000, cacheScope:'private' },
        },
      },
    );
    activeServer = server;
    for (const definition of definitions) {
      server.registerTool(
        definition.name,
        toolConfig(definition, fromJsonSchema),
        async (args, context) => {
          try {
            const resolved = resolveCompactRuntimeCall(definition.name, args || {}, definitions);
            return await invokeTool(resolved.runtimeName, resolved.runtimeArguments, { signal:context?.mcpReq?.signal });
          } catch (error) {
            return { content:[{ type:'text', text:error instanceof Error ? error.message : String(error) }], isError:true };
          }
        },
      );
    }
    return server;
  }, {
    legacy:'serve',
    onerror(error) { onError(error instanceof Error ? error : new Error(String(error))); },
  });

  return {
    definitions,
    async notification(notification) {
      if (!activeServer) return;
      await activeServer.server.notification(notification);
    },
    async close() {
      if (closed) return;
      closed = true;
      await serverHandle.close();
      activeServer = null;
    },
  };
}
