import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { stat } from 'node:fs/promises';
import { assertAllowedCommand } from '../policy.mjs';
import { isWaylandSession } from '../screenshot-portal.mjs';
import { resolveSafePath, text } from '../util.mjs';
import {
  clamp,
  commandExists,
  escapePowerShellSingle,
  jsonResult,
  optionalString,
  requireEnum,
  runFile,
  runOsa,
  runPowerShell,
  safeEnvironment,
  spawnDetached,
  unavailable,
} from './common.mjs';

function durationSpec(value) {
  const raw = optionalString(value) || '10m';
  if (!/^\d+(?:s|m|h|d)$/.test(raw)) throw new Error('since must look like 30s, 10m, 2h, or 1d');
  return raw;
}

export async function serviceTool(args) {
  const action = requireEnum(args.action || 'list', 'action', ['list','status','start','stop','restart']);
  const name = optionalString(args.name);
  if (!['list'].includes(action) && !name) throw new Error('name is required unless action=list');
  const scope = requireEnum(args.scope || 'user', 'scope', ['user','system']);
  const policy = ['list','status'].includes(action) ? null : assertAllowedCommand(`${process.platform === 'win32' ? `${action}-service` : process.platform === 'darwin' ? 'launchctl' : 'systemctl'} ${action} ${name}`);

  if (process.platform === 'win32') {
    if (action === 'list') {
      const { stdout } = await runPowerShell('Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress', { label: 'list services' });
      return text(stdout.trim() || '[]');
    }
    const safe = escapePowerShellSingle(name);
    if (action === 'status') {
      const { stdout } = await runPowerShell(`Get-Service -Name '${safe}' | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json -Compress`, { label: 'service status' });
      return text(stdout.trim());
    }
    const verb = action === 'start' ? 'Start-Service' : action === 'stop' ? 'Stop-Service' : 'Restart-Service';
    await runPowerShell(`${verb} -Name '${safe}' -ErrorAction Stop`, { label: `${action} service`, timeout: 30_000 });
    return text(`${policy?.note ? `${policy.note}\n` : ''}${action} requested for service ${name}.`);
  }

  if (process.platform === 'darwin') {
    if (action === 'list') return text((await runFile('/bin/launchctl', ['list'], { label: 'launchctl list' })).stdout);
    const domain = scope === 'system' ? 'system' : `gui/${process.getuid?.() ?? 0}`;
    const target = `${domain}/${name}`;
    if (action === 'status') {
      const result = await runFile('/bin/launchctl', ['print', target], { label: 'launchctl print', allowFailure: true });
      if (result.code !== 0) throw new Error(result.stderr.trim() || `Service ${target} was not found`);
      return text(result.stdout);
    }
    if (action === 'restart') await runFile('/bin/launchctl', ['kickstart', '-k', target], { label: 'launchctl kickstart' });
    else if (action === 'start') await runFile('/bin/launchctl', ['kickstart', target], { label: 'launchctl kickstart' });
    else await runFile('/bin/launchctl', ['kill', 'SIGTERM', target], { label: 'launchctl stop' });
    return text(`${policy?.note ? `${policy.note}\n` : ''}${action} requested for ${target}.`);
  }

  if (!commandExists('systemctl')) unavailable('Service control', 'systemctl is required on Linux');
  const base = scope === 'user' ? ['--user'] : [];
  if (action === 'list') return text((await runFile('systemctl', [...base, 'list-units', '--type=service', '--all', '--no-pager', '--plain'], { label: 'systemctl list' })).stdout);
  if (action === 'status') {
    const result = await runFile('systemctl', [...base, 'status', name, '--no-pager', '--plain'], { label: 'systemctl status', allowFailure: true });
    const rendered = `${result.stdout}${result.stderr}`.trim();
    return text(rendered, result.code !== 0 && !result.stdout.trim());
  }
  await runFile('systemctl', [...base, action, name], { label: `systemctl ${action}`, timeout: 30_000 });
  return text(`${policy?.note ? `${policy.note}\n` : ''}${action} requested for service ${name}.`);
}

export async function eventLog(args) {
  const limit = clamp(args.limit, 200, 1, 5000);
  const since = durationSpec(args.since);
  const filter = optionalString(args.filter || args.query);
  if (process.platform === 'win32') {
    const log = escapePowerShellSingle(optionalString(args.log) || 'System');
    const n = Number.parseInt(since, 10), unit = since.at(-1);
    const seconds = n * ({ s:1, m:60, h:3600, d:86400 }[unit] || 60);
    const where = filter ? ` | Where-Object { $_.Message -like '*${escapePowerShellSingle(filter)}*' -or $_.ProviderName -like '*${escapePowerShellSingle(filter)}*' }` : '';
    const script = `Get-WinEvent -FilterHashtable @{LogName='${log}';StartTime=(Get-Date).AddSeconds(-${seconds})} -ErrorAction SilentlyContinue${where} | Select-Object -First ${limit} TimeCreated,Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress -Depth 3`;
    return text((await runPowerShell(script, { label: 'event log', timeout: 30_000 })).stdout.trim() || '[]');
  }
  if (process.platform === 'darwin') {
    const argv = ['show','--last',since,'--style','ndjson'];
    if (filter) argv.push('--predicate', `eventMessage CONTAINS[c] ${JSON.stringify(filter)}`);
    const { stdout } = await runFile('/usr/bin/log', argv, { label: 'macOS unified log', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    return text(stdout.split('\n').slice(0, limit).join('\n'));
  }
  if (!commandExists('journalctl')) unavailable('Event logs', 'journalctl is required on Linux');
  const n = Number.parseInt(since, 10), unit = since.at(-1);
  const argv = ['--no-pager','-n',String(limit),'--since',`${n} ${{s:'seconds',m:'minutes',h:'hours',d:'days'}[unit]} ago`,'-o','short-iso'];
  if (filter) argv.push('--grep', filter);
  const result = await runFile('journalctl', argv, { label: 'journalctl', timeout: 30_000, allowFailure: true });
  const rendered = `${result.stdout}${result.stderr}`.trim();
  return text(rendered, result.code !== 0 && !result.stdout.trim());
}

async function connectivityTest(host, port, timeoutMs) {
  return new Promise(resolve => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ ok:false, host, port, error:'timeout', latency_ms:Math.round(performance.now()-started) }), timeoutMs);
    socket.once('connect', () => finish({ ok:true, host, port, latency_ms:Math.round(performance.now()-started) }));
    socket.once('error', error => finish({ ok:false, host, port, error:error.code || error.message, latency_ms:Math.round(performance.now()-started) }));
  });
}

export async function networkTool(args) {
  const action = requireEnum(args.action || 'summary', 'action', ['summary','interfaces','dns','routes','listeners','test']);
  if (action === 'interfaces') return jsonResult(os.networkInterfaces());
  if (action === 'dns') return jsonResult({ servers:dns.getServers(), hostname:os.hostname() });
  if (action === 'summary') return jsonResult({ hostname:os.hostname(), interfaces:os.networkInterfaces(), dns:dns.getServers() });
  if (action === 'test') {
    const host = optionalString(args.host); if (!host) throw new Error('host is required for action=test');
    return jsonResult(await connectivityTest(host, clamp(args.port, 443, 1, 65535), clamp(args.timeout_ms, 3000, 100, 30_000)));
  }
  if (process.platform === 'win32') {
    const script = action === 'routes'
      ? 'Get-NetRoute | Select-Object DestinationPrefix,NextHop,RouteMetric,InterfaceAlias,AddressFamily | ConvertTo-Json -Compress'
      : 'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess,State | Sort-Object LocalPort | ConvertTo-Json -Compress';
    return text((await runPowerShell(script, { label:`network ${action}` })).stdout.trim() || '[]');
  }
  if (action === 'routes') {
    if (commandExists('ip')) return text((await runFile('ip', ['route','show'], { label:'routes' })).stdout);
    if (commandExists('route')) return text((await runFile('route', ['-n'], { label:'routes' })).stdout);
    unavailable('Route inventory', 'ip or route is required');
  }
  if (commandExists('ss')) return text((await runFile('ss', ['-lntup'], { label:'listeners', allowFailure:true })).stdout);
  if (commandExists('netstat')) return text((await runFile('netstat', ['-an'], { label:'listeners' })).stdout);
  unavailable('Listener inventory', 'ss or netstat is required');
}

export async function installedApps(args) {
  const limit = clamp(args.limit, 1000, 1, 10_000);
  const filter = optionalString(args.filter);
  if (process.platform === 'win32') {
    const where = filter ? ` | Where-Object { $_.DisplayName -like '*${escapePowerShellSingle(filter)}*' }` : '';
    const script = `$paths=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');Get-ItemProperty $paths -ErrorAction SilentlyContinue${where}|Where-Object{$_.DisplayName}|Select-Object -First ${limit} DisplayName,DisplayVersion,Publisher,InstallLocation|Sort-Object DisplayName -Unique|ConvertTo-Json -Compress`;
    return text((await runPowerShell(script, { label:'installed apps', timeout:30_000 })).stdout.trim() || '[]');
  }
  if (process.platform === 'darwin') {
    const parsed = JSON.parse((await runFile('/usr/sbin/system_profiler', ['SPApplicationsDataType','-json'], { label:'installed apps', timeout:60_000, maxBuffer:64*1024*1024 })).stdout);
    const apps = (parsed.SPApplicationsDataType || []).filter(app => !filter || String(app._name || '').toLowerCase().includes(filter.toLowerCase())).slice(0, limit);
    return jsonResult(apps.map(app => ({ name:app._name, version:app.version || null, path:app.path || null, signed_by:app.signed_by || null })));
  }
  if (commandExists('dpkg-query')) {
    const { stdout } = await runFile('dpkg-query', ['-W','-f=${binary:Package}\t${Version}\t${Maintainer}\n'], { label:'installed apps', maxBuffer:32*1024*1024 });
    return text(stdout.split('\n').filter(Boolean).filter(line => !filter || line.toLowerCase().includes(filter.toLowerCase())).slice(0, limit).join('\n'));
  }
  if (commandExists('rpm')) {
    const { stdout } = await runFile('rpm', ['-qa','--qf','%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n'], { label:'installed apps', maxBuffer:32*1024*1024 });
    return text(stdout.split('\n').filter(Boolean).filter(line => !filter || line.toLowerCase().includes(filter.toLowerCase())).slice(0, limit).join('\n'));
  }
  unavailable('Installed application inventory', 'dpkg-query or rpm is required');
}

export async function environmentTool(args) {
  return jsonResult({
    platform:process.platform,
    arch:process.arch,
    node:process.versions.node,
    cwd:process.cwd(),
    home:os.homedir(),
    temp:os.tmpdir(),
    shell:process.platform === 'win32' ? process.env.ComSpec || null : process.env.SHELL || null,
    path_entries:String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    ...(args.include_env === true ? { environment:safeEnvironment() } : {}),
  });
}

export async function audioTool(args) {
  const action = requireEnum(args.action || 'status', 'action', ['status','set_volume','mute','unmute']);
  const volume = clamp(args.volume, 50, 0, 100);
  if (process.platform === 'darwin') {
    if (action === 'status') {
      const { stdout } = await runOsa('set v to output volume of (get volume settings)\nset m to output muted of (get volume settings)\nreturn (v as text) & tab & (m as text)', { label:'audio status' });
      const [v,m] = stdout.trim().split('\t'); return jsonResult({ volume:Number(v), muted:m === 'true' });
    }
    await runOsa(action === 'set_volume' ? `set volume output volume ${volume}` : action === 'mute' ? 'set volume with output muted' : 'set volume without output muted', { label:'audio control' });
    return audioTool({ action:'status' });
  }
  if (process.platform === 'win32') {
    if (!commandExists('powershell.exe') && !process.env.SystemRoot) unavailable('Windows audio control');
    if (action === 'status') return text('Windows master-volume status requires the CoreAudio adapter; use set_volume/mute/unmute or install a system audio helper.');
    // Windows has no stable built-in CLI for CoreAudio; use media keys for mute/volume changes.
    const key = action === 'mute' || action === 'unmute' ? '{VOLUME_MUTE}' : null;
    if (key) await runPowerShell(`$w=New-Object -ComObject WScript.Shell;$w.SendKeys('${key}')`, { label:'audio control' });
    else throw new Error('set_volume on Windows requires an installed CoreAudio helper; exact absolute volume is not exposed by a stable built-in command');
    return text(`Audio action ${action} requested.`);
  }
  if (commandExists('wpctl')) {
    if (action === 'status') return text((await runFile('wpctl', ['get-volume','@DEFAULT_AUDIO_SINK@'], { label:'audio status' })).stdout.trim());
    if (action === 'set_volume') await runFile('wpctl', ['set-volume','@DEFAULT_AUDIO_SINK@',`${volume}%`], { label:'audio control' });
    else await runFile('wpctl', ['set-mute','@DEFAULT_AUDIO_SINK@',action === 'mute' ? '1' : '0'], { label:'audio control' });
    return text(`Audio action ${action} completed.`);
  }
  if (commandExists('pactl')) {
    if (action === 'status') return text(`${(await runFile('pactl',['get-sink-volume','@DEFAULT_SINK@'],{label:'audio status'})).stdout}${(await runFile('pactl',['get-sink-mute','@DEFAULT_SINK@'],{label:'audio status'})).stdout}`.trim());
    if (action === 'set_volume') await runFile('pactl', ['set-sink-volume','@DEFAULT_SINK@',`${volume}%`], { label:'audio control' });
    else await runFile('pactl', ['set-sink-mute','@DEFAULT_SINK@',action === 'mute' ? '1' : '0'], { label:'audio control' });
    return text(`Audio action ${action} completed.`);
  }
  if (commandExists('amixer')) {
    if (action === 'status') return text((await runFile('amixer',['get','Master'],{label:'audio status'})).stdout);
    await runFile('amixer', action === 'set_volume' ? ['set','Master',`${volume}%`] : ['set','Master',action === 'mute' ? 'mute' : 'unmute'], { label:'audio control' });
    return text(`Audio action ${action} completed.`);
  }
  unavailable('Audio control', 'wpctl, pactl or amixer is required on Linux');
}

export async function powerAction(args) {
  const action = requireEnum(args.action, 'action', ['lock','sleep','restart','shutdown']);
  const policy = assertAllowedCommand(action === 'restart' ? 'reboot' : action === 'shutdown' ? 'shutdown' : action);
  const delay = clamp(args.delay_seconds, 0, 0, 3600);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay * 1000));
  if (process.platform === 'win32') {
    if (action === 'lock') await runPowerShell('rundll32.exe user32.dll,LockWorkStation', { label:'lock workstation' });
    else if (action === 'sleep') await runPowerShell('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', { label:'sleep workstation' });
    else spawnDetached('shutdown.exe', [action === 'restart' ? '/r' : '/s','/t','0']);
  } else if (process.platform === 'darwin') {
    if (action === 'lock') spawnDetached('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']);
    else if (action === 'sleep') await runFile('/usr/bin/pmset', ['sleepnow'], { label:'sleep' });
    else await runOsa(`tell application "System Events" to ${action === 'restart' ? 'restart' : 'shut down'}`, { label:action });
  } else {
    if (action === 'lock') {
      if (!commandExists('loginctl')) unavailable('Session lock', 'loginctl is required');
      await runFile('loginctl', ['lock-session'], { label:'lock session' });
    } else {
      if (!commandExists('systemctl')) unavailable('Power action', 'systemctl is required');
      await runFile('systemctl', [action === 'sleep' ? 'suspend' : action === 'restart' ? 'reboot' : 'poweroff'], { label:action });
    }
  }
  return text(`${policy.note ? `${policy.note}\n` : ''}Power action ${action} requested.`);
}

export function recordScreenAvailable({
  platform = process.platform,
  wayland = platform === 'linux' ? isWaylandSession() : false,
  commandExistsFn = commandExists,
} = {}) {
  if (platform === 'linux') {
    if (wayland) return commandExistsFn('wf-recorder') && commandExistsFn('timeout');
    return commandExistsFn('ffmpeg');
  }
  if (platform === 'darwin' || platform === 'win32') return commandExistsFn('ffmpeg');
  return false;
}

export async function recordScreen(args) {
  const seconds = clamp(args.duration_seconds, 5, 1, 120);
  const fps = clamp(args.fps, 15, 1, 60);
  const destination = args.destination ? await resolveSafePath(args.destination, 'destination') : path.join(os.tmpdir(), `remcp-screen-${Date.now()}.mp4`);
  if (process.platform === 'linux' && commandExists('wf-recorder') && commandExists('timeout')) {
    const result = await runFile('timeout', ['--signal=INT', `${seconds}s`, 'wf-recorder', '-f',destination,'-r',String(fps),'-c','libx264'], { label:'screen recording', timeout:(seconds+10)*1000, allowFailure:true });
    if (![0, 124, 130].includes(Number(result.code))) throw new Error(result.stderr.trim() || `wf-recorder exited ${result.code}`);
  } else {
    if (process.platform === 'linux' && isWaylandSession()) {
      unavailable('Screen recording', 'wf-recorder and timeout are required on Wayland');
    }
    if (!commandExists('ffmpeg')) {
      if (process.platform === 'darwin') unavailable('Screen recording', 'ffmpeg is required on macOS');
      if (process.platform === 'win32') unavailable('Screen recording', 'ffmpeg is required on Windows');
      unavailable('Screen recording', 'ffmpeg is required on X11');
    }
    let argv;
    if (process.platform === 'win32') argv=['-y','-f','gdigrab','-framerate',String(fps),'-i','desktop','-t',String(seconds),'-pix_fmt','yuv420p',destination];
    else if (process.platform === 'darwin') argv=['-y','-f','avfoundation','-framerate',String(fps),'-i','1:none','-t',String(seconds),'-pix_fmt','yuv420p',destination];
    else argv=['-y','-f','x11grab','-framerate',String(fps),'-i',process.env.DISPLAY || ':0.0','-t',String(seconds),'-pix_fmt','yuv420p',destination];
    await runFile('ffmpeg', argv, { label:'screen recording', timeout:(seconds+20)*1000, maxBuffer:8*1024*1024 });
  }
  const info = await stat(destination);
  return jsonResult({ path:destination, bytes:info.size, duration_seconds:seconds, format:path.extname(destination).slice(1) || 'mp4' });
}

export const diagnosticHandlers = {
  service:serviceTool,
  event_log:eventLog,
  network:networkTool,
  installed_apps:installedApps,
  environment:environmentTool,
  audio:audioTool,
  power_action:powerAction,
  record_screen:recordScreen,
};
