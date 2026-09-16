import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
