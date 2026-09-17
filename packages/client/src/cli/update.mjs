// `remcp update`: install what the server advertises, then let whoever supervises the agent restart
// it. Only a spec the configured package can satisfy is installed, so a pairing response from a
// custom server cannot point this machine at a different package or run a git/URL spec.
import fs from 'node:fs';
import process from 'node:process';

import { supervisorRestart } from '../agent.mjs';
import { isRuntimeSpecFor, normalizeRuntime } from '../runtime.mjs';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { loadConfig, saveConfig } from './config.mjs';
import { installedVersion } from './doctor.mjs';
import { linuxServiceFile, macServiceFile, officialOrigin } from './env.mjs';
import { ensureServiceIfRecorded, npmGlobalInstall, restartPersistentServiceIfInstalled } from './service.mjs';

export async function updateCommand(flags) {
  const cfg = loadConfig();
  // The server advertises which runtime version it expects; an agent that is updating
  // itself passes it through so client and runtime move together.
  const requested = typeof flags.runtime === 'string' ? flags.runtime.trim() : '';
  // Whatever the server advertises is installed globally, so it is validated exactly like the
  // metadata from a pairing response: same package as the configured runtime, a spec that
  // parses, and an explicit --trust-runtime before a custom server may change it.
  let runtimeSpec = cfg.runtime.packageSpec;
  if (requested) {
    // Only `<configured package>@<semver>` is installable: an alias, a git/URL/file spec, a tag or
    // a range would run code the user never agreed to.
    if (!isRuntimeSpecFor(cfg.runtime.packageName, requested)) {
      throw new Error(`--runtime must be ${cfg.runtime.packageName}@<version>`);
    }
    const trusted = cfg.trustRuntime === true
      || Boolean(flags['trust-runtime'])
      || process.env.REMCP_TRUST_RUNTIME === '1'
      // A configuration written before the field existed paired with the official server, which is
      // trusted by definition; refusing it would silently stop every existing device updating.
      || new URL(cfg.serverUrl).origin === officialOrigin;
    if (!trusted) {
      throw new Error(`This machine was paired without trusting ${cfg.serverUrl} to choose a runtime version. Re-run with --trust-runtime if you trust that server.`);
    }
    runtimeSpec = normalizeRuntime({ kind: 'npm', packageName: cfg.runtime.packageName, packageSpec: requested, entry: cfg.runtime.entry }).packageSpec;
  }
  if (flags.check) {
    console.log(JSON.stringify({
      current: VERSION,
      installedRuntime: installedVersion(cfg.runtime.packageName),
      runtimeSpec: runtimeSpec,
      available: `${PACKAGE_NAME}@latest`,
      managedService: fs.existsSync(linuxServiceFile) || fs.existsSync(macServiceFile),
      supervisor: supervisorRestart() ?? 'none',
    }, null, 2));
    return;
  }
  const before = { cli: VERSION, runtime: installedVersion(cfg.runtime.packageName) };
  console.log(`Updating ReMCP to the latest published version (${runtimeSpec})…`);
  npmGlobalInstall(`${PACKAGE_NAME}@latest`, runtimeSpec);
  // The npm prefix can change across Node-manager upgrades. Repair an existing persistent-service
  // launcher only after the install, when globalCliPath() points at the CLI we just installed.
  ensureServiceIfRecorded(cfg);
  // Only a validated spec is persisted, so a failed update cannot leave the install unable to start.
  if (requested && runtimeSpec !== cfg.runtime.packageSpec) saveConfig({ ...cfg, runtime: { ...cfg.runtime, packageSpec: runtimeSpec } });
  const after = { cli: installedVersion(PACKAGE_NAME), runtime: installedVersion(cfg.runtime.packageName) };
  const restarted = restartPersistentServiceIfInstalled();
  if (restarted) {
    console.log(`ReMCP updated and ${restarted} restarted (client ${before.cli} → ${after.cli ?? '?'}, runtime ${before.runtime ?? '?'} → ${after.runtime ?? '?'}).`);
    return;
  }
  // This process is the updater, not the agent: exiting here would restart nothing. The agent sees
  // the exit status, verifies the installed version, and restarts itself.
  console.log(`ReMCP updated (client ${before.cli} → ${after.cli ?? '?'}, runtime ${before.runtime ?? '?'} → ${after.runtime ?? '?'}). The running agent restarts itself to apply it.`);
  if (after.cli === before.cli && after.runtime === before.runtime) {
    console.log('Nothing changed: the installed versions already match the requested ones.');
  }
  return;
}
