import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runAgent, supervisorRestart } from './agent.mjs';
import { isRuntimeSpecFor, normalizeRuntime } from './runtime.mjs';
import { PACKAGE_NAME, VERSION } from './version.mjs';
import { probeFilesystemAccess } from './fs-access.mjs';

import { ensureMachineId, loadConfig, readJsonFile, saveConfig, setTelemetry, telemetryState, writeJsonFile } from './cli/config.mjs';
import { assertRuntimeTrust, pairWithDeviceCode } from './cli/connect.mjs';
import { diagnoseLocalRuntime, installedVersion, runtimeAllowedRoots } from './cli/doctor.mjs';
import { configFile, linuxServiceFile, macServiceFile, npm, officialOrigin, runtimeConfigFile } from './cli/env.mjs';
import { ensureServiceIfRecorded, globalCliPath, installPersistentAgent, npmGlobalInstall, restartPersistentServiceIfInstalled, uninstallPersistentService } from './cli/service.mjs';
import { run } from './cli/shell.mjs';
function parse(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue; }
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, flags, positional };
}

function printHelp() {
  console.log(`ReMCP ${VERSION}\n\nCommands:\n  remcp start\n  remcp status\n  remcp doctor\n  remcp update\n  remcp install\n  remcp uninstall\n  remcp uninstall --purge\n  remcp telemetry [status|on|off]\n  remcp godmode [status|on|off]\n  remcp --version\n\nPairing commands are generated in the ReMCP workspace.\n\nUsage metrics are opt-out (tool names, timings, outcomes only, sent to your own ReMCP\naccount through the paired agent). Disable them at any time with: remcp telemetry off\n\nUnrestricted mode (remcp godmode on) lifts the access roots and the command guardrails for this\ncomputer only. It is deliberately not reachable from a model or an MCP tool.`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parse(argv);

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (command === 'connect') {
    // Like the desktop-app flow this mirrors: with no flags the command talks to the official
    // server, prints a code, opens the browser to approve it, and pairs. `--code` keeps working for
    // the workspace-generated command and for CI, and `--server` for self-hosted deployments.
    const server = String(flags.server || officialOrigin).replace(/\/$/, '');
    const code = String(flags.code || '').replace(/\s+/g, '').toUpperCase();
    assertRuntimeTrust(server, flags);
    let paired;
    let deviceInitiated = false;
    if (code) {
      const response = await fetch(`${server}/api/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, machineId: ensureMachineId(), name: String(flags.name || os.hostname()), hostname: os.hostname(), platform: process.platform, arch: process.arch }),
      });
      if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${await response.text()}`);
      paired = await response.json();
    } else {
      deviceInitiated = true;
      paired = await pairWithDeviceCode(server, flags);
    }
    if (paired.moved_from_another_account) {
      console.log('This computer was paired to another ReMCP account. That device was revoked and this machine now belongs to the account you approved.');
    } else if (paired.movedFromUid) {
      console.log('This computer was paired to another ReMCP account. That device was revoked and this machine now belongs to the account you approved.');
    }
    const config = {
      serverUrl: server,
      deviceId: paired.deviceId || paired.device_id,
      deviceToken: paired.deviceToken || paired.device_token,
      deviceName: String(flags.name || os.hostname()),
      runtime: normalizeRuntime(paired.runtime),
      machineId: ensureMachineId(),
      // Remember whether this machine's owner trusted the server to name a runtime version. The
      // auto-updater must not widen that decision on its own later.
      trustRuntime: Boolean(flags['trust-runtime']) || new URL(server).origin === officialOrigin,
    };
    saveConfig(config);
    const accountEmail = String(paired.account?.email || '');
    console.log(`Paired ${os.hostname()} with ${server}${accountEmail ? ` as ${accountEmail}` : ''}`);
    if (flags.install) {
      installPersistentAgent(config);
      return;
    }
    // Only the command that asked for its own code keeps running: someone who ran `remcp connect` on
    // a fresh machine expects the connection to be live when the command finishes. A workspace code
    // keeps its old meaning (pair, then `remcp start` or `--install`).
    if (!deviceInitiated) return;
    // The machine survives a reboot afterwards. Nothing about the credential
    // changes: the same revocable token is used either way.
    installPersistentAgent(config);
    return;
  }

  if (command === 'start') {
    const cfg = loadConfig();
    const telemetry = telemetryState();
    await runAgent({
      ...cfg,
      autoUpdate: cfg.autoUpdate !== false,
      trustRuntime: cfg.trustRuntime === true
        || process.env.REMCP_TRUST_RUNTIME === '1'
        || new URL(cfg.serverUrl).origin === officialOrigin,
      telemetryEnabled: telemetry.enabled,
      installReported: telemetry.installReported,
      installSpec: `${PACKAGE_NAME}@${VERSION}`,
      persistState: patch => saveConfig({ ...cfg, ...patch }),
    });
    return;
  }

  if (command === 'auto-update') {
    const action = String(positional[0] || 'status').toLowerCase();
    const cfg = loadConfig(false) || {};
    if (action === 'status') {
      console.log(JSON.stringify({ autoUpdate: cfg.autoUpdate !== false, checkIntervalHours: 6 }, null, 2));
      return;
    }
    if (action === 'on' || action === 'enable') { saveConfig({ ...cfg, autoUpdate: true }); console.log('Auto-update enabled.'); return; }
    if (action === 'off' || action === 'disable') { saveConfig({ ...cfg, autoUpdate: false }); console.log('Auto-update disabled. Run `remcp update` yourself when you want a new version.'); return; }
    throw new Error('Usage: remcp auto-update [status|on|off]');
  }

  if (command === 'telemetry') {
    const action = String(positional[0] || 'status').toLowerCase();
    if (action === 'status') {
      console.log(JSON.stringify(telemetryState(), null, 2));
      return;
    }
    if (action === 'on' || action === 'enable') {
      console.log(JSON.stringify(setTelemetry(true), null, 2));
      restartPersistentServiceIfInstalled();
      console.log('Usage metrics enabled and the agent restarted to apply it.');
      return;
    }
    if (action === 'off' || action === 'disable') {
      console.log(JSON.stringify(setTelemetry(false), null, 2));
      restartPersistentServiceIfInstalled();
      console.log('Usage metrics disabled and the agent restarted to apply it.');
      return;
    }
    throw new Error('Usage: remcp telemetry [status|on|off]');
  }

  // The switch that lifts every guardrail: no access roots, no command blocklist, no catastrophic
  // command protection. It lives here, on the machine, because a model that could turn it on would
  // turn any prompt injection into root. The runtime refuses to set it through MCP
  // (`set_config_value` lists what it accepts, and this is not on the list).
  if (command === 'godmode' || command === 'unrestricted') {
    const action = String(positional[0] || 'status').toLowerCase();
    if (action === 'status') {
      const runtimeFile = readJsonFile(runtimeConfigFile);
      const state = runtimeFile.unrestricted === true || process.env.REMCP_RUNTIME_UNRESTRICTED === '1';
      console.log(JSON.stringify({
        unrestricted: state,
        source: runtimeFile.unrestricted === true ? runtimeConfigFile : process.env.REMCP_RUNTIME_UNRESTRICTED === '1' ? 'REMCP_RUNTIME_UNRESTRICTED' : 'default',
        meaning: state
          ? 'Every path and every command is allowed. Commands run as the user the agent runs as, so sudo still needs your own sudoers rules; nothing here grants root by itself.'
          : 'The runtime confines file access to its allowed roots and applies its command guardrails.',
      }, null, 2));
      return;
    }
    if (!['on', 'off', 'enable', 'disable'].includes(action)) throw new Error('Usage: remcp godmode [status|on|off]');
    const enabled = action === 'on' || action === 'enable';
    writeJsonFile(runtimeConfigFile, { ...readJsonFile(runtimeConfigFile), unrestricted: enabled });
    const restarted = restartPersistentServiceIfInstalled();
    if (enabled) {
      console.error('Unrestricted mode is ON for this computer: every path and every command is allowed, including sudo. Anything the model is asked to do -- and anything a prompt injection asks it to do -- can now change this machine. Turn it off with `remcp godmode off` when you are done.');
    } else {
      console.log('Unrestricted mode is off: the runtime is back to its allowed roots and command guardrails.');
    }
    console.log(JSON.stringify({ unrestricted: enabled, configFile: runtimeConfigFile, restarted }, null, 2));
    return;
  }

  if (command === 'status' || command === 'doctor') {
    const cfg = loadConfig();
    const health = await fetch(`${cfg.serverUrl}/health?fresh=${Date.now()}`, { cache: 'no-store' }).then(r => r.json()).catch(error => ({ error: error.message }));
    const report = {
      configured: true,
      cliVersion: VERSION,
      deviceId: cfg.deviceId,
      deviceName: cfg.deviceName,
      server: cfg.serverUrl,
      runtime: cfg.runtime,
      telemetry: telemetryState(),
      serverHealth: health,
    };
    // `doctor` answers the question the workspace cannot: is this machine actually able to run a
    // tool? It resolves the runtime entry, installs nothing, and tries one real MCP handshake with
    // the runtime, so the failure is visible here instead of only as "runtime not running".
    if (command === 'doctor') {
      report.diagnosis = await diagnoseLocalRuntime(cfg);
      // A computer can pass every other check and still be unable to write where the tools work:
      // macOS answers EACCES for Desktop until TCC is granted, Windows has Controlled folder access,
      // Linux answers EACCES for a folder this user does not own. The probe writes and removes a
      // temporary file in each allowed root, so the doctor reports what actually happens rather than
      // what the permission bits claim, and names the fix for this platform and this binary.
      report.diagnosis.filesystem = await probeFilesystemAccess({ roots: runtimeAllowedRoots() });
    }
    console.log(JSON.stringify(report, null, 2));
    if (command === 'doctor' && report.diagnosis.verdict !== 'ok') process.exitCode = 1;
    return;
  }

  if (command === 'install') {
    installPersistentAgent(loadConfig());
    return;
  }

  if (command === 'update') {
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

  if (command === 'uninstall') {
    uninstallPersistentService();
    if (flags.purge) {
      const cfg = loadConfig(false);
      const specs = [PACKAGE_NAME, ...(cfg?.runtime?.packageName ? [cfg.runtime.packageName] : [])];
      run(npm.command, [...npm.args, 'uninstall', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
    }
    return;
  }

  printHelp();
}