import path from 'node:path';

const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const PACKAGE_SPEC = /^[^\s]+$/;

export function normalizeRuntime(value) {
  if (!value || value.kind !== 'npm') throw new Error('Pairing server did not provide a supported local runtime');
  const packageName = String(value.packageName || '');
  const packageSpec = String(value.packageSpec || '');
  const entry = String(value.entry || '');
  if (!PACKAGE_NAME.test(packageName)) throw new Error('Pairing server returned an invalid runtime package name');
  if (!PACKAGE_SPEC.test(packageSpec) || !packageSpec.startsWith(`${packageName}@`)) throw new Error('Pairing server returned an invalid runtime package spec');
  if (!entry || path.isAbsolute(entry) || entry.split(/[\\/]+/).includes('..')) throw new Error('Pairing server returned an invalid runtime entry');
  return { kind: 'npm', packageName, packageSpec, entry };
}
