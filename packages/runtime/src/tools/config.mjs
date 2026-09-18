import { applyLiveConfig, liveConfig, persistConfigValue, runtimeConfig, settableKeys, validateConfigValue } from '../config.mjs';
import { text } from '../util.mjs';

// The one write into this runtime's own configuration, and a deliberately narrow one.
//
// Desktop Commander exposes its whole config object to the model, including the directories it may
// touch and the commands it must refuse. Those two decide what this computer exposes, so they stay
// with the person at the computer: only the telemetry opt-out and the read/buffer/output limits can be
// changed here, and the change is written back to runtime.json so it survives a restart.
export async function setConfigValueTool(args = {}) {
  const key = String(args.key || '').trim();
  const value = validateConfigValue(key, args.value);
  applyLiveConfig(key, value);
  const file = persistConfigValue(key, value);
  return text(JSON.stringify({
    ok: true,
    key,
    value,
    applied: 'immediately',
    savedTo: file,
    note: `Effective now and after a restart. Settable through MCP: ${settableKeys.join(', ')}. Access roots, blocked commands, the command guardrail, the shell and the write limit stay with the person at this computer.`,
    effective: Object.fromEntries(settableKeys.map(name => [name, liveConfig(name)])),
  }, null, 2));
}

export const configToolHandlers = {
  set_config_value: args => setConfigValueTool(args),
};

// Kept so a future tool can report the settable surface without duplicating the list.
export const configSurface = Object.freeze({ settableKeys, roots: runtimeConfig.allowedRoots });
