import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Code,
  Drawer,
  Group,
  Loader,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useSearchParams } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconCertificate,
  IconDownload,
  IconKey,
  IconPlus,
  IconRouter,
  IconTicket,
  IconTrash,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { TableSkeleton } from '../components/TableSkeleton';
import { EmptyState } from '../components/EmptyState';
import {
  useAddDeviceRule,
  useCreateVpnDevice,
  useDecommissionVpnDevice,
  useDeleteDeviceRule,
  useDeviceRules,
  useDownloadVpnDevicePackage,
  useGenerateEnrollToken,
  useIssueAndroidCertificate,
  useRevokeVpnDeviceCertificate,
  useSetDeviceOverrides,
  useSetVpnDeviceEnabled,
  useUserActivity,
  useVpnDevice,
  useVpnDevices,
  type CreateVpnDeviceInput,
  type DevicePlatform,
  type DeviceRuleKind,
  type DeviceRuleProtocol,
  type TunnelMode,
} from '../api/hooks';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { notifyError, notifyOk } from '../lib/notify';

const STATUS_LABEL: Record<string, string> = {
  active: 'activo',
  disabled: 'desactivado',
  decommissioned: 'dado de baja',
};
const STATUS_COLOR: Record<string, string> = {
  active: 'teal',
  disabled: 'gray',
  decommissioned: 'red',
};

const CERT_STATUS_COLOR: Record<string, string> = {
  active: 'teal',
  superseded: 'gray',
  revoked: 'red',
};

const NAME_PART_RE = /^[a-z0-9-]{2,32}$/;

function CreateDeviceModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const create = useCreateVpnDevice();
  const [ownerUser, setOwnerUser] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [platform, setPlatform] = useState<DevicePlatform>('windows');
  const [tunnelMode, setTunnelMode] = useState<TunnelMode | ''>('');
  const [notes, setNotes] = useState('');
  const [certDays, setCertDays] = useState<number | ''>('');
  const [renewAfterDays, setRenewAfterDays] = useState<number | ''>('');

  const valid = NAME_PART_RE.test(ownerUser) && NAME_PART_RE.test(deviceLabel);

  const reset = () => {
    setOwnerUser('');
    setDeviceLabel('');
    setOwnerName('');
    setPlatform('windows');
    setTunnelMode('');
    setNotes('');
    setCertDays('');
    setRenewAfterDays('');
  };

  const submit = async () => {
    const input: CreateVpnDeviceInput = {
      ownerUser: ownerUser.trim(),
      deviceLabel: deviceLabel.trim(),
      ownerName: ownerName.trim() || null,
      platform,
      tunnelMode: tunnelMode || undefined,
      notes: notes.trim() || null,
      certDays: certDays === '' ? null : certDays,
      renewAfterDays: renewAfterDays === '' ? null : renewAfterDays,
    };
    try {
      const device = await create.mutateAsync(input);
      notifyOk(`Dispositivo "${device.username}" creado con IP ${device.framedIp}`);
      reset();
      onClose();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Nuevo dispositivo VPN">
      <Stack>
        <Group grow>
          <TextInput
            label="Usuario (owner_user)"
            description="Identificador corto de la persona: minusculas, numeros, guiones (2-32)"
            placeholder="juan"
            value={ownerUser}
            onChange={(e) => setOwnerUser(e.currentTarget.value.toLowerCase())}
            error={ownerUser && !NAME_PART_RE.test(ownerUser) ? 'Formato invalido' : undefined}
            required
          />
          <TextInput
            label="Etiqueta del dispositivo"
            description="minusculas, numeros, guiones (2-32)"
            placeholder="laptop"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.currentTarget.value.toLowerCase())}
            error={deviceLabel && !NAME_PART_RE.test(deviceLabel) ? 'Formato invalido' : undefined}
            required
          />
        </Group>
        <Text size="xs" c="dimmed">
          Usuario RADIUS resultante:{' '}
          <span className="mono">
            vpn-{ownerUser || '…'}-{deviceLabel || '…'}
          </span>
        </Text>
        <TextInput
          label="Nombre del dueno (opcional)"
          value={ownerName}
          onChange={(e) => setOwnerName(e.currentTarget.value)}
        />
        <Group grow>
          <Select
            label="Plataforma"
            data={[
              { value: 'windows', label: 'Windows' },
              { value: 'android', label: 'Android' },
              { value: 'linux', label: 'Linux' },
            ]}
            value={platform}
            onChange={(v) => setPlatform((v as DevicePlatform) ?? 'windows')}
            allowDeselect={false}
          />
          <Select
            label="Modo de tunel"
            description={`Por defecto: ${platform === 'linux' ? 'split' : 'full'}`}
            placeholder="(por defecto)"
            data={[
              { value: 'full', label: 'Completo (full)' },
              { value: 'split', label: 'Dividido (split)' },
            ]}
            value={tunnelMode || null}
            onChange={(v) => setTunnelMode((v as TunnelMode) ?? '')}
            clearable
          />
        </Group>
        <Group grow>
          <NumberInput
            label="Dias de vida del certificado"
            description="Vacio = usar el valor general"
            placeholder="p.ej. 7 para un dispositivo siempre conectado"
            value={certDays}
            onChange={(v) => setCertDays(v === '' ? '' : Number(v))}
            min={1}
          />
          <NumberInput
            label="Renovar a partir de (dias)"
            description="Vacio = usar el valor general"
            value={renewAfterDays}
            onChange={(v) => setRenewAfterDays(v === '' ? '' : Number(v))}
            min={1}
          />
        </Group>
        <Textarea
          label="Notas"
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
          autosize
          minRows={2}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!valid}>
            Crear
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const RULE_KIND_LABEL: Record<DeviceRuleKind, string> = {
  internet: 'Internet',
  lan: 'Toda la LAN',
  custom: 'Destino concreto',
};

function ruleDescription(rule: { kind: DeviceRuleKind; destCidr: string | null; protocol: DeviceRuleProtocol | null; port: number | null }): string {
  if (rule.kind !== 'custom') return RULE_KIND_LABEL[rule.kind];
  const proto = rule.protocol && rule.protocol !== 'any' ? ` ${rule.protocol}` : '';
  const port = rule.port ? `:${rule.port}` : '';
  return `${rule.destCidr}${proto}${port}`;
}

function DeviceRulesSection({
  username,
  allowRadiusHost,
  allowMariadbHost,
}: {
  username: string;
  allowRadiusHost: boolean;
  allowMariadbHost: boolean;
}) {
  const rules = useDeviceRules(username);
  const addRule = useAddDeviceRule();
  const deleteRule = useDeleteDeviceRule();
  const setOverrides = useSetDeviceOverrides();

  const [kind, setKind] = useState<DeviceRuleKind>('internet');
  const [destCidr, setDestCidr] = useState('');
  const [protocol, setProtocol] = useState<DeviceRuleProtocol | ''>('');
  const [port, setPort] = useState<number | ''>('');

  const submitRule = async () => {
    try {
      await addRule.mutateAsync({
        username,
        input: {
          kind,
          destCidr: kind === 'custom' ? destCidr.trim() : undefined,
          protocol: kind === 'custom' && protocol ? protocol : undefined,
          port: kind === 'custom' && port !== '' ? port : undefined,
        },
      });
      setDestCidr('');
      setProtocol('');
      setPort('');
      notifyOk('Permiso anadido');
    } catch (err) {
      notifyError(err);
    }
  };

  const removeRule = async (ruleId: number) => {
    try {
      await deleteRule.mutateAsync({ username, ruleId });
      notifyOk('Permiso eliminado');
    } catch (err) {
      notifyError(err);
    }
  };

  const confirmOverride = (field: 'allowRadiusHost' | 'allowMariadbHost', label: string, host: string) => {
    modals.openConfirmModal({
      title: `Permitir acceso a ${label}`,
      children: (
        <Stack gap="xs">
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            {host} esta bloqueado para todos los clientes VPN por defecto. Esta excepcion es
            explicita: el dispositivo podra llegar a {label} desde la VPN.
          </Alert>
        </Stack>
      ),
      labels: { confirm: 'Permitir de todas formas', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await setOverrides.mutateAsync({ username, overrides: { [field]: true } });
          notifyOk('Excepcion activada');
        } catch (err) {
          notifyError(err);
        }
      },
    });
  };

  const disableOverride = async (field: 'allowRadiusHost' | 'allowMariadbHost') => {
    try {
      await setOverrides.mutateAsync({ username, overrides: { [field]: false } });
      notifyOk('Excepcion desactivada');
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <div>
      <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
        Permisos de red (firewall)
      </Text>
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          El acceso a EST (para darse de alta/renovar) siempre esta permitido. RADIUS
          (192.168.10.28) y MariaDB (192.168.10.30) estan siempre bloqueados salvo excepcion
          explicita.
        </Text>

        {rules.data?.length ? (
          <Table verticalSpacing={4}>
            <Table.Tbody>
              {rules.data.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Badge size="sm" variant="light">
                      {ruleDescription(r)}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() => removeRule(r.id)}
                    >
                      Quitar
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text size="sm" c="dimmed">
            Sin permisos: este dispositivo solo puede llegar a EST.
          </Text>
        )}

        <Group grow align="flex-end">
          <Select
            label="Anadir permiso"
            data={[
              { value: 'internet', label: 'Internet' },
              { value: 'lan', label: 'Toda la LAN' },
              { value: 'custom', label: 'Destino concreto' },
            ]}
            value={kind}
            onChange={(v) => setKind((v as DeviceRuleKind) ?? 'internet')}
            allowDeselect={false}
          />
          {kind === 'custom' && (
            <>
              <TextInput
                label="Destino"
                placeholder="1.2.3.4 o 1.2.3.0/24"
                value={destCidr}
                onChange={(e) => setDestCidr(e.currentTarget.value)}
              />
              <Select
                label="Protocolo"
                placeholder="cualquiera"
                data={[
                  { value: 'tcp', label: 'TCP' },
                  { value: 'udp', label: 'UDP' },
                ]}
                value={protocol || null}
                onChange={(v) => setProtocol((v as DeviceRuleProtocol) ?? '')}
                clearable
              />
              <NumberInput
                label="Puerto"
                placeholder="todos"
                value={port}
                onChange={(v) => setPort(v === '' ? '' : Number(v))}
                min={1}
                max={65535}
              />
            </>
          )}
          <Button
            size="sm"
            loading={addRule.isPending}
            disabled={kind === 'custom' && !destCidr.trim()}
            onClick={submitRule}
          >
            Anadir
          </Button>
        </Group>

        <Group grow mt="xs">
          <Switch
            label="Permitir RADIUS (192.168.10.28)"
            checked={allowRadiusHost}
            onChange={(e) =>
              e.currentTarget.checked
                ? confirmOverride('allowRadiusHost', 'RADIUS', '192.168.10.28')
                : disableOverride('allowRadiusHost')
            }
          />
          <Switch
            label="Permitir MariaDB (192.168.10.30)"
            checked={allowMariadbHost}
            onChange={(e) =>
              e.currentTarget.checked
                ? confirmOverride('allowMariadbHost', 'MariaDB', '192.168.10.30')
                : disableOverride('allowMariadbHost')
            }
          />
        </Group>
      </Stack>
    </div>
  );
}

function DeviceDrawer({ username, onClose }: { username: string | null; onClose: () => void }) {
  const detail = useVpnDevice(username);
  const activity = useUserActivity(username);
  const setEnabled = useSetVpnDeviceEnabled();
  const enrollToken = useGenerateEnrollToken();
  const revokeCert = useRevokeVpnDeviceCertificate();
  const decommission = useDecommissionVpnDevice();
  const downloadPackage = useDownloadVpnDevicePackage();
  const issueAndroidCert = useIssueAndroidCertificate();

  const runIssueAndroidCert = async () => {
    if (!username) return;
    try {
      const result = await issueAndroidCert.mutateAsync(username);
      const downloadUrl = `${window.location.origin}/api/vpn-android/${encodeURIComponent(username)}/download?token=${encodeURIComponent(result.downloadToken)}`;
      modals.open({
        title: 'Certificado emitido',
        size: 'lg',
        closeOnClickOutside: false,
        children: (
          <Stack>
            <Text size="sm" c="dimmed">
              Enlace de un solo uso, valido 15 minutos y solo desde la red local o la VPN. Ni la
              contrasena ni el enlace se pueden volver a mostrar: copialos ahora y pasaselos al
              dueno del dispositivo por un canal aparte (nunca los dos juntos).
            </Text>
            <Text size="sm" fw={600}>
              Enlace de descarga (.sswan)
            </Text>
            <Code block style={{ wordBreak: 'break-all' }}>
              {downloadUrl}
            </Code>
            <Group justify="flex-end">
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  navigator.clipboard?.writeText(downloadUrl);
                  notifyOk('Enlace copiado');
                }}
              >
                Copiar enlace
              </Button>
            </Group>
            <Text size="sm" fw={600}>
              Contrasena del .p12
            </Text>
            <Code block style={{ wordBreak: 'break-all' }}>
              {result.password}
            </Code>
            <Group justify="flex-end">
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  navigator.clipboard?.writeText(result.password);
                  notifyOk('Contrasena copiada');
                }}
              >
                Copiar contrasena
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Caduca: {formatDateTime(result.expiresAt)}
            </Text>
            <Group justify="flex-end">
              <Button onClick={() => modals.closeAll()}>Cerrar</Button>
            </Group>
          </Stack>
        ),
      });
    } catch (err) {
      notifyError(err);
    }
  };

  const runDownloadPackage = async () => {
    if (!username) return;
    try {
      await downloadPackage.mutateAsync(username);
    } catch (err) {
      notifyError(err);
    }
  };

  const runGenerateToken = async () => {
    if (!username) return;
    try {
      const result = await enrollToken.mutateAsync(username);
      modals.open({
        title: 'Token de alta generado',
        children: (
          <Stack>
            <Text size="sm" c="dimmed">
              Valido 24 horas, un solo uso. No se puede volver a mostrar: cópialo ahora. Generar uno
              nuevo invalida este.
            </Text>
            <Code block style={{ wordBreak: 'break-all' }}>
              {result.token}
            </Code>
            <Text size="xs" c="dimmed">
              Caduca: {formatDateTime(result.expiresAt)}
            </Text>
            <Group justify="flex-end">
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(result.token);
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

  const confirmRevoke = () => {
    if (!username) return;
    let reason = '';
    modals.open({
      title: 'Revocar certificado activo',
      children: (
        <Stack>
          <Text size="sm">
            Se marca como revocado, se regenera la CRL de su CA y se desconecta la sesion si esta
            activa.
          </Text>
          <TextInput
            label="Motivo"
            placeholder="p.ej. dispositivo perdido"
            onChange={(e) => (reason = e.currentTarget.value)}
            required
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => modals.closeAll()}>
              Cancelar
            </Button>
            <Button
              color="red"
              onClick={async () => {
                if (!reason.trim()) return notifyError(new Error('El motivo es obligatorio'));
                try {
                  await revokeCert.mutateAsync({ username, reason: reason.trim() });
                  notifyOk('Certificado revocado');
                  modals.closeAll();
                } catch (err) {
                  notifyError(err);
                }
              }}
            >
              Revocar
            </Button>
          </Group>
        </Stack>
      ),
    });
  };

  const confirmDecommission = () => {
    if (!username) return;
    modals.openConfirmModal({
      title: `Dar de baja "${username}"`,
      children: (
        <Text size="sm">
          Revoca todos sus certificados activos, desconecta la sesion y borra sus filas RADIUS
          (libera la IP). El historial de certificados se conserva.
        </Text>
      ),
      labels: { confirm: 'Dar de baja', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await decommission.mutateAsync(username);
          notifyOk('Dispositivo dado de baja');
          onClose();
        } catch (err) {
          notifyError(err);
        }
      },
    });
  };

  const device = detail.data;
  const hasActiveCert = device?.certificates.some((c) => c.status === 'active') ?? false;

  return (
    <Drawer
      opened={!!username}
      onClose={onClose}
      position="right"
      size="lg"
      scrollAreaComponent={ScrollArea.Autosize}
      title={
        <Group gap="sm">
          <Title order={4}>{username}</Title>
          {device && (
            <Badge color={STATUS_COLOR[device.status]} variant="light">
              {STATUS_LABEL[device.status]}
            </Badge>
          )}
        </Group>
      }
    >
      {detail.isLoading || !device ? (
        <Center h={200}>
          <Loader />
        </Center>
      ) : (
        <Stack gap="md">
          <Group justify="space-between">
            <Switch
              label={device.enabled ? 'Activo' : 'Desactivado'}
              checked={device.enabled}
              disabled={device.status === 'decommissioned'}
              onChange={async (e) => {
                try {
                  await setEnabled.mutateAsync({
                    username: device.username,
                    enabled: e.currentTarget.checked,
                  });
                  notifyOk(
                    e.currentTarget.checked ? 'Dispositivo activado' : 'Dispositivo desactivado',
                  );
                } catch (err) {
                  notifyError(err);
                }
              }}
            />
            {device.status !== 'decommissioned' && (
              <Button
                size="xs"
                color="red"
                variant="light"
                leftSection={<IconTrash size={14} />}
                onClick={confirmDecommission}
              >
                Dar de baja
              </Button>
            )}
          </Group>

          <Card padding="sm">
            <Stack gap={4}>
              <Text size="sm">
                <b>Dueno:</b> {device.ownerName ?? device.ownerUser} ({device.ownerUser}) ·{' '}
                <b>Etiqueta:</b> {device.deviceLabel}
              </Text>
              <Text size="sm">
                <b>Plataforma:</b> {device.platform} · <b>Tunel:</b> {device.tunnelMode}
              </Text>
              <Text size="sm">
                <b>IP:</b> <span className="mono">{device.framedIp ?? '—'}</span>
              </Text>
              {device.notes && (
                <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                  {device.notes}
                </Text>
              )}
              <Text size="sm">
                <b>Ultima emision:</b> {formatDateTime(device.lastIssuedAt)} ·{' '}
                <b>Proxima renovacion esperada:</b> {formatDateTime(device.nextRenewalExpectedAt)}
              </Text>
            </Stack>
          </Card>

          {device.status !== 'decommissioned' && (
            <Group>
              {device.platform !== 'android' && (
                <>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconTicket size={14} />}
                    loading={enrollToken.isPending}
                    onClick={runGenerateToken}
                  >
                    Generar token de alta
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconDownload size={14} />}
                    loading={downloadPackage.isPending}
                    onClick={runDownloadPackage}
                  >
                    Descargar paquete de conexion
                  </Button>
                </>
              )}
              {device.platform === 'android' && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconKey size={14} />}
                  loading={issueAndroidCert.isPending}
                  onClick={runIssueAndroidCert}
                >
                  Emitir certificado
                </Button>
              )}
              {hasActiveCert && (
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  leftSection={<IconCertificate size={14} />}
                  onClick={confirmRevoke}
                >
                  Revocar certificado
                </Button>
              )}
            </Group>
          )}

          {device.status !== 'decommissioned' && (
            <DeviceRulesSection
              username={device.username}
              allowRadiusHost={device.allowRadiusHost}
              allowMariadbHost={device.allowMariadbHost}
            />
          )}

          <div>
            <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
              Historial de certificados
            </Text>
            {device.certificates.length ? (
              <Table.ScrollContainer minWidth={480}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Serial</Table.Th>
                      <Table.Th>Estado</Table.Th>
                      <Table.Th>Vigencia</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {device.certificates.map((c) => (
                      <Table.Tr key={c.serial}>
                        <Table.Td className="mono">{c.serial}</Table.Td>
                        <Table.Td>
                          <Badge size="sm" variant="light" color={CERT_STATUS_COLOR[c.status]}>
                            {c.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>
                          {formatDateTime(c.notBefore)} — {formatDateTime(c.notAfter)}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            ) : (
              <Text size="sm" c="dimmed">
                Todavia no tiene ningun certificado emitido.
              </Text>
            )}
          </div>

          <div>
            <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
              Sesiones
            </Text>
            {activity.data?.sessions.length ? (
              <Table.ScrollContainer minWidth={480}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Inicio</Table.Th>
                      <Table.Th>Duracion</Table.Th>
                      <Table.Th ta="right">Trafico</Table.Th>
                      <Table.Th>Estado</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {activity.data.sessions.map((s) => (
                      <Table.Tr key={s.acctuniqueid}>
                        <Table.Td style={{ whiteSpace: 'nowrap' }}>
                          {formatDateTime(s.acctstarttime)}
                        </Table.Td>
                        <Table.Td>{formatDuration(s.acctsessiontime)}</Table.Td>
                        <Table.Td ta="right">{formatBytes(s.bytes)}</Table.Td>
                        <Table.Td>
                          {s.acctstoptime ? (
                            <Text size="xs" c="dimmed">
                              cerrada
                            </Text>
                          ) : (
                            <Badge size="sm" variant="light" color="teal">
                              activa
                            </Badge>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            ) : (
              <EmptyState
                icon={<IconRouter size={22} />}
                title="Sin sesiones"
                description="Este dispositivo todavia no se ha conectado."
              />
            )}
          </div>
        </Stack>
      )}
    </Drawer>
  );
}

export function VpnDevicesPage() {
  const list = useVpnDevices();
  const [createOpen, setCreateOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [openUsername, setOpenUsername] = useState<string | null>(null);

  useEffect(() => {
    const open = searchParams.get('open');
    if (open) {
      setOpenUsername(open);
      const next = new URLSearchParams(searchParams);
      next.delete('open');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <Stack gap="lg">
      <PageHeader
        title="Dispositivos VPN"
        subtitle="Alta y gestion de dispositivos IKEv2/EAP-TLS (usuario RADIUS + certificado)"
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
            Nuevo dispositivo
          </Button>
        }
      />

      <SectionCard
        title="Dispositivos"
        subtitle="Tabla panel_vpn_devices"
        bodyPadding={false}
        footer={
          <Text size="sm" c="dimmed">
            {list.data?.length ?? 0} dispositivo(s)
          </Text>
        }
      >
        <Table.ScrollContainer minWidth={640}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Usuario</Table.Th>
                <Table.Th>Dueno</Table.Th>
                <Table.Th>Plataforma</Table.Th>
                <Table.Th>Tunel</Table.Th>
                <Table.Th>IP</Table.Th>
                <Table.Th>Estado</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.isLoading && <TableSkeleton rows={4} cols={6} />}
              {!list.isLoading && !list.data?.length && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <EmptyState
                      icon={<IconRouter size={22} />}
                      title="Sin dispositivos"
                      description="Da de alta el primero con 'Nuevo dispositivo'."
                    />
                  </Table.Td>
                </Table.Tr>
              )}
              {list.data?.map((d) => (
                <Table.Tr
                  key={d.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setOpenUsername(d.username)}
                >
                  <Table.Td fw={550}>{d.username}</Table.Td>
                  <Table.Td>{d.ownerName ?? d.ownerUser}</Table.Td>
                  <Table.Td>{d.platform}</Table.Td>
                  <Table.Td>{d.tunnelMode}</Table.Td>
                  <Table.Td className="mono">{d.framedIp ?? '—'}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={STATUS_COLOR[d.status]}>
                      {STATUS_LABEL[d.status]}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SectionCard>

      <CreateDeviceModal opened={createOpen} onClose={() => setCreateOpen(false)} />
      <DeviceDrawer username={openUsername} onClose={() => setOpenUsername(null)} />
    </Stack>
  );
}
