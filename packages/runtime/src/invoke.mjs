import { toolHandlers } from './catalog.mjs';
import { recordEvent } from './telemetry.mjs';
import { ToolError, text } from './util.mjs';

export function hasTool(name) {
  return toolHandlers.has(name);
}

function errorKind(error) {
  if (error instanceof ToolError) return 'tool_error';
  const code = error?.code;
  return typeof code === 'string' && code ? code.slice(0, 32) : 'runtime_error';
}

export async function invokeTool(name, args = {}) {
  const started = performance.now();
  const definition = toolHandlers.get(name);
  if (!definition) {
    recordEvent('tool_call', { tool: 'unknown_tool', success: false, errorKind: 'unknown_tool', durationMs: 0 });
    return text(`Unknown tool: ${name}`, true);
  }
  try {
    const result = await definition.handler(args || {});
    recordEvent('tool_call', { tool: definition.name, durationMs: performance.now() - started, success: result?.isError !== true });
    return result;
  } catch (error) {
    recordEvent('tool_call', { tool: definition.name, durationMs: performance.now() - started, success: false, errorKind: errorKind(error) });
    if (error instanceof ToolError) return text(error.message, true);
    return text(`Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}
