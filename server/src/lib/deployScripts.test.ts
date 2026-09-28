import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

/**
 * `deploy/vpn-gateway-agent.sh` corre sin supervision en la VM VPN (systemd
 * timer): shellcheck sobre el fichero real, no solo sobre una plantilla en
 * memoria como en vpnClientPackages.test.ts.
 */
const DEPLOY_DIR = join(import.meta.dirname, '..', '..', '..', 'deploy');

function hasCli(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

test(
  'shellcheck no encuentra problemas en deploy/vpn-gateway-agent.sh',
  { skip: !hasCli('shellcheck') && 'shellcheck no disponible' },
  () => {
    execFileSync('shellcheck', ['vpn-gateway-agent.sh'], { cwd: DEPLOY_DIR, timeout: 5000 });
  },
);
