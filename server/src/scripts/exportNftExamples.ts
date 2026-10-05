/**
 * Exporta los ficheros nftables de ejemplo (rangos y lista INVENTADOS) a un
 * directorio, para revisarlos o para la prueba funcional en un netns:
 *
 *   node --import tsx src/scripts/exportNftExamples.ts <directorio>
 *
 * Escribe: vpn-profiles.nft (sets), nftables-fragmento-perfiles.conf
 * (fragmento), nftables.conf.ensamblado (stand-in de la .29 + fragmento +
 * sets) y nftables.conf.ensamblado-sets-vacios (idem sin rellenar los sets).
 * No toca nada fuera de ese directorio ni ninguna base de datos.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNftablesFragment, buildSetsFile } from '../services/vpnProfilesNft.js';
import {
  EXAMPLE_DESTINATIONS,
  assembleNftablesConf,
  exampleRanges,
} from '../services/vpnProfilesNft.fixture.js';

const dir = process.argv[2];
if (dir) {
  mkdirSync(dir, { recursive: true });
  const options = { lanCidr: '192.168.10.0/24', estPort: 8443, egressInterface: null };
  const generatedAt = new Date();
  const sets = buildSetsFile({
    ranges: exampleRanges(),
    destinations: EXAMPLE_DESTINATIONS,
    lanCidr: options.lanCidr,
    generatedAt,
  });
  writeFileSync(join(dir, 'vpn-profiles.nft'), sets);
  writeFileSync(
    join(dir, 'nftables-fragmento-perfiles.conf'),
    buildNftablesFragment(options, generatedAt),
  );
  writeFileSync(join(dir, 'nftables.conf.ensamblado'), assembleNftablesConf(options, sets).conf);
  writeFileSync(
    join(dir, 'nftables.conf.ensamblado-sets-vacios'),
    assembleNftablesConf(options, null).conf,
  );
  console.log(`Ejemplos escritos en ${dir}`);
}
