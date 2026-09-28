import { useState } from 'react';
import {
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconCertificate,
  IconDownload,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import {
  useCancelPendingIntermediate,
  useGenerateIntermediate,
  useImportIntermediate,
  usePkiStatus,
  useRegenerateCrl,
  type PkiCaSummary,
} from '../api/hooks';
import { formatDateTime } from '../lib/format';
import { notifyError, notifyOk } from '../lib/notify';

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/x-pem-file' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** `null` = sin caducidad conocida. Colorea segun cuanto falta (aviso a 90 dias). */
function expiryBadge(notAfter: string | null) {
  if (!notAfter) return null;
  const days = Math.floor(
    (new Date(notAfter.replace(' ', 'T')).getTime() - Date.now()) / 86_400_000,
  );
  const color = days < 0 ? 'red' : days < 30 ? 'red' : days < 90 ? 'orange' : 'teal';
  const label = days < 0 ? 'caducado' : `caduca en ${days} dias`;
  return (
    <Badge size="sm" variant="light" color={color}>
      {label}
    </Badge>
  );
}

const STATUS_LABEL: Record<PkiCaSummary['status'], string> = {
  pending: 'pendiente de importar',
  active: 'activa',
  retiring: 'retirandose',
  retired: 'retirada',
};
const STATUS_COLOR: Record<PkiCaSummary['status'], string> = {
  pending: 'yellow',
  active: 'teal',
  retiring: 'orange',
  retired: 'gray',
};

function GenerateModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const generate = useGenerateIntermediate();
  const [subjectCn, setSubjectCn] = useState('VPN Intermediate CA');

  const submit = async () => {
    try {
      const result = await generate.mutateAsync(subjectCn.trim());
      notifyOk('CA intermedia generada: descarga el CSR y firmalo con la raiz offline');
      onClose();
      modals.open({
        title: 'CSR de la CA intermedia',
        size: 'lg',
        children: (
          <Stack>
            <Text size="sm" c="dimmed">
              Firma este CSR con la CA raiz offline (Easy-RSA) y luego usa "Importar certificado"
              con el certificado resultante y el de la raiz.
            </Text>
            <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {result.csrPem}
            </Code>
            <Group justify="flex-end">
              <Button
                variant="light"
                leftSection={<IconDownload size={16} />}
                onClick={() =>
                  download(`${result.subjectCn.replace(/\s+/g, '-')}.csr.pem`, result.csrPem)
                }
              >
                Descargar .csr
              </Button>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(result.csrPem);
                  notifyOk('Copiado');
                }}
              >
                Copiar
              </Button>
            </Group>
          </Stack>
        ),
      });
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Generar CA intermedia">
      <Stack>
        <Text size="sm" c="dimmed">
          Genera una clave privada (se cifra y se guarda en el panel) y su CSR. La clave nunca sale
          del servidor.
        </Text>
        <TextInput
          label="Sujeto (CN)"
          value={subjectCn}
          onChange={(e) => setSubjectCn(e.currentTarget.value)}
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={generate.isPending} disabled={!subjectCn.trim()}>
            Generar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ImportModal({ id, onClose }: { id: number; onClose: () => void }) {
  const importCa = useImportIntermediate();
  const [certPem, setCertPem] = useState('');
  const [rootCertPem, setRootCertPem] = useState('');

  const submit = async () => {
    try {
      await importCa.mutateAsync({ id, certPem: certPem.trim(), rootCertPem: rootCertPem.trim() });
      notifyOk('CA intermedia activada');
      onClose();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack>
      <Textarea
        label="Certificado de la CA intermedia (firmado por la raiz)"
        placeholder="-----BEGIN CERTIFICATE-----"
        minRows={6}
        autosize
        value={certPem}
        onChange={(e) => setCertPem(e.currentTarget.value)}
        styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
      />
      <Textarea
        label="Certificado de la CA raiz"
        placeholder="-----BEGIN CERTIFICATE-----"
        minRows={6}
        autosize
        value={rootCertPem}
        onChange={(e) => setRootCertPem(e.currentTarget.value)}
        styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          onClick={submit}
          loading={importCa.isPending}
          disabled={!certPem.trim() || !rootCertPem.trim()}
        >
          Importar y activar
        </Button>
      </Group>
    </Stack>
  );
}

const CRL_SYSTEMD_SERVICE = `[Unit]
Description=Descarga la CRL de la VPN y recarga FreeRADIUS si ha cambiado
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/radius-panel-crl-sync.sh`;

const CRL_SYSTEMD_TIMER = `[Unit]
Description=Comprueba la CRL de la VPN cada hora

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target`;

function crlSyncScript(chainUrl: string, crlUrl: string): string {
  return `#!/bin/sh
set -eu
CRL_URL="${crlUrl}"
CRL_FILE=/etc/raddb/certs/vpn-crl.pem
TMP=$(mktemp)

curl -fsS "$CRL_URL" -o "$TMP"
openssl crl -in "$TMP" -noout   # valida que la CRL descargada es correcta antes de instalarla

if ! cmp -s "$TMP" "$CRL_FILE" 2>/dev/null; then
  mv "$TMP" "$CRL_FILE"
  openssl rehash "$(dirname "$CRL_FILE")"
  systemctl reload freeradius
else
  rm -f "$TMP"
fi

# Cadena de CA (intermedia + raiz), para referencia: ${chainUrl}
`;
}

export function PkiPage() {
  const status = usePkiStatus();
  const cancel = useCancelPendingIntermediate();
  const regenerate = useRegenerateCrl();
  const [generateOpen, setGenerateOpen] = useState(false);

  const root = status.data?.root ?? null;
  const intermediates = status.data?.intermediates ?? [];
  const pending = intermediates.find((i) => i.status === 'pending');
  const canGenerate = !pending;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const chainUrl = `${origin}/pki/ca-chain.pem`;
  const crlUrl = `${origin}/pki/crl.pem`;

  const confirmCancel = (ca: PkiCaSummary) =>
    modals.openConfirmModal({
      title: 'Cancelar CA intermedia pendiente',
      children: (
        <Text size="sm">
          Se borra la clave privada generada y el CSR. Tendras que generar una CA intermedia nueva.
        </Text>
      ),
      labels: { confirm: 'Cancelar CA', cancel: 'Volver' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await cancel.mutateAsync(ca.id);
          notifyOk('CA intermedia pendiente cancelada');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  const openImport = (ca: PkiCaSummary) =>
    modals.open({
      title: `Importar certificado — ${ca.subjectCn}`,
      size: 'lg',
      children: <ImportModal id={ca.id} onClose={() => modals.closeAll()} />,
    });

  const runRegenerate = async (ca: PkiCaSummary) => {
    try {
      await regenerate.mutateAsync(ca.id);
      notifyOk('CRL regenerada');
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack gap="lg">
      <PageHeader
        title="PKI de la VPN"
        subtitle="CA intermedia para EAP-TLS (IKEv2/strongSwan) y publicacion de su CRL"
        actions={
          canGenerate && (
            <Button
              leftSection={<IconCertificate size={16} />}
              onClick={() => setGenerateOpen(true)}
            >
              Generar CA intermedia
            </Button>
          )
        }
      />

      <SectionCard title="CA raiz" subtitle="Offline: el panel nunca tiene su clave privada">
        {root ? (
          <Stack gap={4}>
            <Text size="sm">
              <b>Sujeto:</b> {root.subjectCn}
            </Text>
            <Text size="sm">
              <b>Serial:</b> <span className="mono">{root.serial}</span>
            </Text>
            <Group gap="xs">
              <Text size="sm">
                <b>Caducidad:</b> {formatDateTime(root.notAfter)}
              </Text>
              {expiryBadge(root.notAfter)}
            </Group>
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            Todavia no se ha importado ninguna CA raiz. Se registra la primera vez que importas una
            CA intermedia firmada por ella.
          </Text>
        )}
      </SectionCard>

      <SectionCard
        title="CA intermedia"
        subtitle="Firma los certificados de dispositivo y publica la CRL"
        footer={
          <Text size="sm" c="dimmed">
            {status.data?.activeDeviceCertificates ?? 0} certificado(s) de dispositivo activo(s)
          </Text>
        }
      >
        {intermediates.length === 0 && (
          <Text size="sm" c="dimmed">
            No hay ninguna CA intermedia todavia. Genera una para empezar.
          </Text>
        )}
        <Stack gap="md">
          {intermediates.map((ca) => (
            <div
              key={ca.id}
              style={{ borderTop: '1px solid var(--mantine-color-default-border)', paddingTop: 12 }}
            >
              <Group justify="space-between" wrap="wrap">
                <Stack gap={4}>
                  <Group gap="xs">
                    <Title order={5}>{ca.subjectCn ?? `CA intermedia #${ca.id}`}</Title>
                    <Badge size="sm" color={STATUS_COLOR[ca.status]} variant="light">
                      {STATUS_LABEL[ca.status]}
                    </Badge>
                    {ca.status === 'active' && expiryBadge(ca.notAfter)}
                  </Group>
                  {ca.serial && (
                    <Text size="sm">
                      <b>Serial:</b> <span className="mono">{ca.serial}</span>
                    </Text>
                  )}
                  {ca.spkiSha256 && (
                    <Text size="xs" c="dimmed" className="mono">
                      SPKI SHA-256: {ca.spkiSha256}
                    </Text>
                  )}
                  {ca.notAfter && (
                    <Text size="sm">
                      <b>Caducidad:</b> {formatDateTime(ca.notAfter)}
                    </Text>
                  )}
                  {(ca.status === 'active' || ca.status === 'retiring') && (
                    <Text size="sm">
                      <b>CRL:</b> numero {ca.crlNumber} · ultima{' '}
                      {formatDateTime(ca.crlLastGeneratedAt)}
                      {' · '}
                      proxima {formatDateTime(ca.crlNextUpdate)}
                    </Text>
                  )}
                </Stack>
                <Group gap="xs">
                  {ca.status === 'pending' && (
                    <>
                      <Button
                        size="xs"
                        leftSection={<IconUpload size={14} />}
                        onClick={() => openImport(ca)}
                      >
                        Importar certificado
                      </Button>
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => confirmCancel(ca)}
                      >
                        Cancelar
                      </Button>
                    </>
                  )}
                  {(ca.status === 'active' || ca.status === 'retiring') && (
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconRefresh size={14} />}
                      loading={regenerate.isPending}
                      onClick={() => runRegenerate(ca)}
                    >
                      Regenerar CRL
                    </Button>
                  )}
                </Group>
              </Group>
            </div>
          ))}
        </Stack>
      </SectionCard>

      <SectionCard
        title="Publicacion"
        subtitle="Sin autenticacion: la consultan los dispositivos y el host de FreeRADIUS"
      >
        <Stack gap="xs">
          <Text size="sm">
            <b>Cadena de CA</b> (intermedia + raiz):
          </Text>
          <Code block>{chainUrl}</Code>
          <Text size="sm">
            <b>CRL</b> vigente de cada intermedia (se regenera al revocar y al menos una vez al
            dia):
          </Text>
          <Code block>{crlUrl}</Code>
        </Stack>
      </SectionCard>

      <SectionCard
        title="Actualizacion en el host de FreeRADIUS"
        subtitle="Comando y unidad systemd de ejemplo: descarga la CRL cada hora y recarga solo si cambio"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            /usr/local/bin/radius-panel-crl-sync.sh
          </Text>
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {crlSyncScript(chainUrl, crlUrl)}
          </Code>
          <Text size="sm" c="dimmed">
            /etc/systemd/system/radius-panel-crl-sync.service
          </Text>
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {CRL_SYSTEMD_SERVICE}
          </Code>
          <Text size="sm" c="dimmed">
            /etc/systemd/system/radius-panel-crl-sync.timer
          </Text>
          <Code block style={{ whiteSpace: 'pre-wrap' }}>
            {CRL_SYSTEMD_TIMER}
          </Code>
          <Text size="xs" c="dimmed">
            Tras copiar los ficheros: systemctl daemon-reload &amp;&amp; systemctl enable --now
            radius-panel-crl-sync.timer
          </Text>
        </Stack>
      </SectionCard>

      <GenerateModal opened={generateOpen} onClose={() => setGenerateOpen(false)} />
    </Stack>
  );
}
