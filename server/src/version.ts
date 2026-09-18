import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_NAME = 'Radius Panel';
export const APP_VERSION = readVersion();
