import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconDownload,
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import {
  useDeleteRestrictedDestination,
  useDownloadProfilesNft,
  useSaveRestrictedDestination,
  useSetProfileRanges,
  useVpnProfiles,
  type ProfileRangesView,
  type RestrictedDestination,
  type RestrictedProtocol,
} from '../api/hooks';
import { notifyError, notifyOk } from '../lib/notify';

/**
 * Perfiles de acceso VPN (solo admin): rango de IPs de cada perfil y lista
 * global de destinos de los perfiles restringidos. El panel NO aplica nada en
 * la VM VPN: genera vpn-profiles.nft para descargarlo y aplicarlo a mano con
 * deploy/vpn-gateway-apply-profiles.sh.
 */

function RangesSection() {
  const profiles = useVpnProfiles();
  const save = useSetProfileRanges();
  const [draft, setDraft] = useState<ProfileRangesView | null>(null);

  useEffect(() => {
    if (profiles.data) setDraft(profiles.data.ranges);
  }, [profiles.data]);

  if (!profiles.data || !draft) return <Skeleton height={220} />;
  const { data } = profiles;

  const setField = (
    profile: keyof ProfileRangesView,
    field: 'rangeStart' | 'rangeEnd',
    value: string,
  ) => setDraft({ ...draft, [profile]: { ...draft[profile], [field]: value.trim() || null } });

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.ranges);

  const submit = async () => {
    try {
      await save.mutateAsync(draft);
      notifyOk(
        'Rangos guardados. Descarga y aplica el vpn-profiles.nft para que la VM VPN los use.',
      );
    } catch (err) {
      notifyError(err, 'No se han guardado los rangos');
    }
  };

  return (
    <SectionCard
      title="Rangos de IP por perfil"
      subtitle={`Dentro de ${data.lanCidr}, sin solaparse entre perfiles`}
      actions={
        <Button size="xs" onClick={submit} loading={save.isPending} disabled={!dirty}>
          Guardar rangos
        </Button>
      }
    >
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          La IP fija de cada dispositivo sale del rango de su perfil; si el rango se llena, el alta
          falla (no se usa nunca otro rango). Un perfil sin rango no admite dispositivos. No pueden
          incluir {data.reservedHosts.join(', ')}
          {data.dhcp ? ` ni pisar el DHCP del router (${data.dhcp.start}-${data.dhcp.end})` : ''} ni
          dejar fuera la IP de un dispositivo existente.
        </Text>
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Perfil</Table.Th>
                <Table.Th>Primera IP</Table.Th>
                <Table.Th>Ultima IP</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.profiles.map((p) => (
                <Table.Tr key={p.profile}>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm" fw={550}>
                        {p.label}
                      </Text>
                      <Code>{p.profile}</Code>
                      {p.infrastructureAccess && (
                        <Tooltip label={data.infrastructureWarning}>
                          <Badge size="xs" color="red" variant="light">
                            infraestructura
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      placeholder="192.168.10.100"
                      value={draft[p.profile].rangeStart ?? ''}
                      onChange={(e) => setField(p.profile, 'rangeStart', e.currentTarget.value)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      placeholder="192.168.10.109"
                      value={draft[p.profile].rangeEnd ?? ''}
                      onChange={(e) => setField(p.profile, 'rangeEnd', e.currentTarget.value)}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </SectionCard>
  );
}

function DestinationModal({
  entry,
  opened,
  onClose,
  lanCidr,
}: {
  entry: RestrictedDestination | null;
  opened: boolean;
  onClose: () => void;
  lanCidr: string;
}) {
  const save = useSaveRestrictedDestination();
  const [destCidr, setDestCidr] = useState('');
  const [protocol, setProtocol] = useState<RestrictedProtocol>('tcp');
  const [ports, setPorts] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (!opened) return;
    setDestCidr(entry?.destCidr ?? '');
    setProtocol(entry?.protocol ?? 'tcp');
    setPorts(entry?.ports ?? '');
    setComment(entry?.comment ?? '');
  }, [opened, entry]);

  const submit = async () => {
    try {
      await save.mutateAsync({
        id: entry?.id ?? null,
        input: {
          destCidr: destCidr.trim(),
          protocol,
          ports: protocol === 'icmp' ? null : ports.trim() || null,
          comment: comment.trim() || null,
        },
      });
      notifyOk(entry ? 'Entrada actualizada' : 'Entrada anadida');
      onClose();
    } catch (err) {
      notifyError(err, 'No se ha guardado la entrada');
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={entry ? 'Editar destino' : 'Nuevo destino permitido'}
    >
      <Stack>
        <TextInput
          label="Destino"
          description={`IPv4 o CIDR dentro de ${lanCidr} (p.ej. 192.168.10.50 o 192.168.10.0/28)`}
          value={destCidr}
          onChange={(e) => setDestCidr(e.currentTarget.value)}
          required
        />
        <Group grow align="flex-start">
          <Select
            label="Protocolo"
            data={['tcp', 'udp', 'icmp']}
            value={protocol}
            onChange={(v) => setProtocol((v as RestrictedProtocol) ?? 'tcp')}
            allowDeselect={false}
          />
          <TextInput
            label="Puertos"
            description="22,443,8000-8100. Vacio = todos"
            value={protocol === 'icmp' ? '' : ports}
            onChange={(e) => setPorts(e.currentTarget.value)}
            disabled={protocol === 'icmp'}
          />
        </Group>
        <TextInput
          label="Comentario"
          description="Solo para ti: no se usa en las reglas"
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          maxLength={128}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} loading={save.isPending} disabled={!destCidr.trim()}>
            Guardar
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RestrictedListSection() {
  const profiles = useVpnProfiles();
  const remove = useDeleteRestrictedDestination();
  const [editing, setEditing] = useState<RestrictedDestination | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const confirmDelete = (entry: RestrictedDestination) =>
    modals.openConfirmModal({
      title: 'Quitar destino de la lista',
      children: (
        <Text size="sm">
          Los perfiles restringidos dejaran de llegar a <Code>{entry.destCidr}</Code> (
          {entry.protocol}
          {entry.ports ? ` ${entry.ports}` : ''}) cuando se aplique el nuevo vpn-profiles.nft.
        </Text>
      ),
      labels: { confirm: 'Quitar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await remove.mutateAsync(entry.id);
          notifyOk('Entrada quitada');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  const destinations = profiles.data?.destinations ?? [];

  return (
    <SectionCard
      title="Lista restringida"
      subtitle="Destinos a los que llegan lan_restricted e internet_lan_restricted (lista global compartida)"
      actions={
        <Button
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            setEditing(null);
            setModalOpen(true);
          }}
        >
          Anadir destino
        </Button>
      }
      bodyPadding={false}
    >
      {profiles.isLoading ? (
        <Skeleton height={120} m="md" />
      ) : destinations.length ? (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Destino</Table.Th>
                <Table.Th>Protocolo</Table.Th>
                <Table.Th>Puertos</Table.Th>
                <Table.Th>Comentario</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {destinations.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td className="mono">{d.destCidr}</Table.Td>
                  <Table.Td>{d.protocol}</Table.Td>
                  <Table.Td className="mono">
                    {d.ports ?? (d.protocol === 'icmp' ? '—' : 'todos')}
                  </Table.Td>
                  <Table.Td>{d.comment || '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <ActionIcon
                        variant="subtle"
                        aria-label="Editar"
                        onClick={() => {
                          setEditing(d);
                          setModalOpen(true);
                        }}
                      >
                        <IconPencil size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Quitar"
                        onClick={() => confirmDelete(d)}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      ) : (
        <EmptyState
          icon={<IconInfoCircle size={22} />}
          title="Lista vacia"
          description="Mientras este vacia, los perfiles restringidos solo pueden usar el alta/renovacion EST."
        />
      )}
      <DestinationModal
        entry={editing}
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        lanCidr={profiles.data?.lanCidr ?? '192.168.10.0/24'}
      />
    </SectionCard>
  );
}

export function VpnProfilesPage() {
  const download = useDownloadProfilesNft();

  const runDownload = async (kind: 'sets' | 'fragment') => {
    try {
      await download.mutateAsync(kind);
      notifyOk(
        kind === 'sets'
          ? 'vpn-profiles.nft descargado: revisalo y aplicalo en la VM VPN con deploy/vpn-gateway-apply-profiles.sh'
          : 'Fragmento descargado: revisalo e integralo a mano en /etc/nftables.conf (una vez)',
      );
    } catch (err) {
      notifyError(err, 'No se ha podido generar el fichero');
    }
  };

  return (
    <Stack gap="lg">
      <PageHeader
        title="Perfiles de acceso"
        subtitle="Que puede alcanzar cada dispositivo por el tunel: rangos de IP por perfil y destinos permitidos"
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              onClick={() => runDownload('fragment')}
              loading={download.isPending && download.variables === 'fragment'}
            >
              Fragmento de nftables.conf
            </Button>
            <Button
              leftSection={<IconDownload size={16} />}
              onClick={() => runDownload('sets')}
              loading={download.isPending && download.variables === 'sets'}
            >
              Descargar vpn-profiles.nft
            </Button>
          </Group>
        }
      />

      <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
        <Text size="sm">
          Los cambios de aqui no se aplican solos. Las <b>reglas</b> viven en{' '}
          <Code>/etc/nftables.conf</Code> de la VM VPN (192.168.10.29): el fragmento se revisa e
          integra a mano una sola vez (sets vacios + reglas fijas; con los sets vacios no pasa nada
          de la VPN). Lo que cambia con los rangos y la lista es <Code>vpn-profiles.nft</Code>, que
          solo rellena esos sets y se aplica con <Code>deploy/vpn-gateway-apply-profiles.sh</Code>{' '}
          (con confirmacion y reversion automatica en 60 s). Antes de integrar el fragmento, ejecuta
          una vez <Code>--init-empty</Code> en la VM VPN: el <Code>include</Code> final de
          <Code>nftables.conf</Code> no puede apuntar a un fichero que no existe (la maquina
          arrancaria sin firewall).
        </Text>
      </Alert>

      <RangesSection />
      <RestrictedListSection />
    </Stack>
  );
}
