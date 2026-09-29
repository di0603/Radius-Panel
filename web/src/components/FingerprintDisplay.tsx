import { Stack, Text } from '@mantine/core';
import type { FormattedFingerprint } from '../api/hooks';

/**
 * Huella para comparar a ojo contra lo que muestra la app al confiar en un
 * servidor por primera vez (prompt 12.5, confianza en el primer uso):
 * "codigo corto" grande y monoespaciado para comparar de un vistazo, huella
 * completa debajo en texto mas pequeno para verificar del todo si hiciera
 * falta. Ver README, "Aprovisionamiento de apps".
 */
export function FingerprintDisplay({
  label,
  fingerprint,
}: {
  label: string;
  fingerprint: FormattedFingerprint | null;
}) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" fw={600}>
        {label}
      </Text>
      {fingerprint ? (
        <>
          <Text ff="monospace" fw={700} size="lg" style={{ letterSpacing: 1 }}>
            {fingerprint.short}
          </Text>
          <Text ff="monospace" size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
            {fingerprint.full}
          </Text>
        </>
      ) : (
        <Text size="sm" c="dimmed">
          (sin configurar todavia)
        </Text>
      )}
    </Stack>
  );
}
