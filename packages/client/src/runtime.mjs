import path from 'node:path';

const PACKAGE_NAME = /^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/i;
// A runtime spec is a plain published version of one package. Anything else — an npm alias
// (`npm:@other/pkg`), a git/https/file spec, a tag, or a version range — is a way to make a device
// install and execute code the user never agreed to, so only `name@x.y.z[-pre][+build]` is accepted.
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';

export function normalizeRuntime(value) {
  if (!value || value.kind !== 'npm') throw new Error('Pairing server did not provide a supported local runtime');
  const packageName = String(value.packageName || '');
  const packageSpec = String(value.packageSpec || '');
  const entry = String(value.entry || '');
  if (!PACKAGE_NAME.test(packageName)) throw new Error('Pairing server returned an invalid runtime package name');
  if (!isRuntimeSpecFor(packageName, packageSpec)) throw new Error(`Runtime package spec must be ${packageName}@<version>`);
   const entryParts = entry.split(/[\\/]+/);
   if (!entry || entry.includes('\0') || path.isAbsolute(entry) || entryParts.some(part => !part || part === '.' || part === '..')) throw new Error('Pairing server returned an invalid runtime entry');

  return { kind: 'npm', packageName, packageSpec, entry };
}

// True only for `<packageName>@<semver>` of exactly that package. Exported so the CLI and the agent
// can validate a server-advertised version without repeating the rule.
export function isRuntimeSpecFor(packageName, packageSpec) {
  if (!PACKAGE_NAME.test(String(packageName || ''))) return false;
  const escaped = String(packageName).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`^${escaped}@(${SEMVER})$`).test(String(packageSpec || ''));
}
