import { useState } from 'react';
import {
  ActionIcon,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Pagination,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import dayjs from 'dayjs';
import {
  IconDownload,
  IconHistory,
  IconPlugConnected,
  IconPlugConnectedX,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import { useActiveSessions, useDisconnectSession, useSessionHistory } from '../api/hooks';
import type { Session } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { downloadCsv } from '../lib/csv';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { notifyError, notifyOk } from '../lib/notify';

const PAGE = 25;

function sessionCsvRow(s: Session) {
  return {
    usuario: s.username,
    ip: s.framedipaddress,
    nas: s.nasipaddress,
    origen: s.callingstationid,
    inicio: s.acctstarttime ?? '',
    fin: s.acctstoptime ?? '',
    duracion_s: s.acctsessiontime ?? 0,
    entrada_bytes: s.acctinputoctets ?? 0,
    salida_bytes: s.acctoutputoctets ?? 0,
    causa: s.acctterminatecause,
  };
}

function SessionRows({ items }: { items: Session[] }) {
  return (
    <>
      {items.map((s) => (
        <Table.Tr key={s.acctuniqueid}>
          <Table.Td fw={500}>{s.username}</Table.Td>
          <Table.Td>{s.framedipaddress || '—'}</Table.Td>
          <Table.Td>{s.nasipaddress}</Table.Td>
          <Table.Td>{s.callingstationid || '—'}</Table.Td>
          <Table.Td>{formatDateTime(s.acctstarttime)}</Table.Td>
          <Table.Td>{formatDuration(s.acctsessiontime)}</Table.Td>
          <Table.Td>
            ↑ {formatBytes(s.acctinputoctets)} / ↓ {formatBytes(s.acctoutputoctets)}
          </Table.Td>
        </Table.Tr>
      ))}
    </>
  );
}

/* ------------------------------- Activas -------------------------- */

function ActiveTab() {
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [interval, setIntervalMs] = useState('15');
  const [paused, setPaused] = useState(false);

  const q = useActiveSessions({
    search: debouncedSearch,
    limit: PAGE,
    offset: (page - 1) * PAGE,
    refetchMs: paused ? undefined : Number(interval) * 1000,
  });
  const disconnect = useDisconnectSession();
  const totalPages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE));
  const coaEnabled = q.data?.coaEnabled ?? false;

  const confirmDisconnect = (s: Session) =>
    modals.openConfirmModal({
      title: 'Desconectar sesion',
      children: (
        <Text size="sm">
          Se enviara un Disconnect-Request al NAS <b>{s.nasipaddress}</b> para la sesion de{' '}
          <b>{s.username}</b>.
        </Text>
      ),
      labels: { confirm: 'Desconectar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res = await disconnect.mutateAsync(s.acctuniqueid);
          if (res.acknowledged) notifyOk(`El NAS confirmo la desconexion (${res.result})`);
          else notifyError(new Error(res.result), 'El NAS respondio');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  return (
    <SectionCard
      title="Sesiones abiertas"
      subtitle={
        coaEnabled
          ? 'Filas de radacct sin acctstoptime'
          : 'Desconexion deshabilitada (COA_ENABLED=false en el servidor)'
      }
      actions={
        <Group gap="xs" wrap="wrap">
          <TextInput
            placeholder="Buscar usuario / IP"
            leftSection={<IconSearch size={16} />}
            size="xs"
            w={220}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setPage(1);
            }}
          />
          <SegmentedControl
            size="xs"
            value={interval}
            onChange={setIntervalMs}
            data={[
              { label: '5s', value: '5' },
              { label: '15s', value: '15' },
              { label: '30s', value: '30' },
              { label: '60s', value: '60' },
            ]}
          />
          <Switch
            size="sm"
            label="pausa"
            checked={paused}
            onChange={(e) => setPaused(e.currentTarget.checked)}
          />
          <Tooltip label="Refrescar ahora">
            <ActionIcon
              variant="light"
              size="lg"
              onClick={() => q.refetch()}
              loading={q.isFetching}
              aria-label="Refrescar"
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
          <Button
            variant="default"
            size="xs"
            leftSection={<IconDownload size={14} />}
            disabled={!q.data?.items.length}
            onClick={() =>
              downloadCsv(
                `sesiones-activas-${dayjs().format('YYYYMMDD-HHmm')}`,
                (q.data?.items ?? []).map(sessionCsvRow),
              )
            }
          >
            Exportar
          </Button>
        </Group>
      }
      bodyPadding={false}
      footer={
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {q.data?.total ?? 0} sesiones activas
          </Text>
          <Pagination value={page} onChange={setPage} total={totalPages} />
        </Group>
      }
    >
      <Table.ScrollContainer minWidth={900}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Usuario</Table.Th>
              <Table.Th>IP asignada</Table.Th>
              <Table.Th>NAS</Table.Th>
              <Table.Th>MAC / origen</Table.Th>
              <Table.Th>Inicio</Table.Th>
              <Table.Th>Duracion</Table.Th>
              <Table.Th>Trafico</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.isLoading && (
              <Table.Tr>
                <Table.Td colSpan={8}>
                  <Center h={120}>
                    <Loader />
                  </Center>
                </Table.Td>
              </Table.Tr>
            )}
            {q.data?.items.map((s) => (
              <Table.Tr key={s.acctuniqueid}>
                <Table.Td fw={550}>{s.username}</Table.Td>
                <Table.Td className="mono">{s.framedipaddress || '—'}</Table.Td>
                <Table.Td className="mono">{s.nasipaddress}</Table.Td>
                <Table.Td className="mono">{s.callingstationid || '—'}</Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  {formatDateTime(s.acctstarttime)}
                </Table.Td>
                <Table.Td>{formatDuration(s.acctsessiontime)}</Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  ↑ {formatBytes(s.acctinputoctets)} / ↓ {formatBytes(s.acctoutputoctets)}
                </Table.Td>
                <Table.Td>
                  <Tooltip label={coaEnabled ? 'Desconectar' : 'Desconexion deshabilitada'}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={!coaEnabled}
                      onClick={() => confirmDisconnect(s)}
                    >
                      <IconPlugConnectedX size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
            {q.data && !q.data.items.length && (
              <Table.Tr>
                <Table.Td colSpan={8}>
                  <EmptyState
                    icon={<IconPlugConnected size={22} />}
                    title="No hay sesiones activas"
                    description="Cuando un NAS envie accounting start, la sesion aparecera aqui."
                  />
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </SectionCard>
  );
}

/* ------------------------------ Historial ------------------------- */

function HistoryTab() {
  const [username, setUsername] = useState('');
  const [nas, setNas] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [acc, setAcc] = useState<Session[]>([]);

  const q = useSessionHistory({
    username: username || undefined,
    nasipaddress: nas || undefined,
    from: from || undefined,
    to: to || undefined,
    limit: PAGE,
    cursor,
  });

  // `acc` = páginas anteriores ya cargadas; `q.data.items` = página actual.
  const items = [...acc, ...(q.data?.items ?? [])];

  const resetAndRefetch = () => {
    setCursor(undefined);
    setAcc([]);
  };

  const loadMore = () => {
    if (!q.data?.nextCursor) return;
    setAcc((prev) => [...prev, ...(q.data?.items ?? [])]);
    setCursor(q.data.nextCursor);
  };

  return (
    <Stack gap="md">
      <Card>
        <Group align="flex-end" wrap="wrap" gap="sm">
          <TextInput
            label="Usuario"
            placeholder="cualquiera"
            size="xs"
            value={username}
            onChange={(e) => {
              setUsername(e.currentTarget.value);
              resetAndRefetch();
            }}
          />
          <TextInput
            label="NAS (IP)"
            placeholder="cualquiera"
            size="xs"
            value={nas}
            onChange={(e) => {
              setNas(e.currentTarget.value);
              resetAndRefetch();
            }}
          />
          <TextInput
            label="Desde"
            type="datetime-local"
            size="xs"
            value={from}
            onChange={(e) => {
              setFrom(e.currentTarget.value.replace('T', ' '));
              resetAndRefetch();
            }}
          />
          <TextInput
            label="Hasta"
            type="datetime-local"
            size="xs"
            value={to}
            onChange={(e) => {
              setTo(e.currentTarget.value.replace('T', ' '));
              resetAndRefetch();
            }}
          />
          <Button
            variant="default"
            size="xs"
            leftSection={<IconDownload size={14} />}
            disabled={!items.length}
            onClick={() =>
              downloadCsv(
                `sesiones-historial-${dayjs().format('YYYYMMDD-HHmm')}`,
                items.map(sessionCsvRow),
              )
            }
          >
            Exportar
          </Button>
        </Group>
      </Card>

      <SectionCard
        title="Historial"
        subtitle="Sesiones cerradas y en curso"
        bodyPadding={false}
        footer={
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {q.data?.total != null ? `${q.data.total} registros` : `${items.length} mostrados`}
            </Text>
            <Button
              variant="light"
              size="xs"
              disabled={!q.data?.nextCursor || q.isFetching}
              loading={q.isFetching && !!cursor}
              onClick={loadMore}
            >
              Cargar mas
            </Button>
          </Group>
        }
      >
        <Table.ScrollContainer minWidth={900}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Usuario</Table.Th>
                <Table.Th>IP asignada</Table.Th>
                <Table.Th>NAS</Table.Th>
                <Table.Th>MAC / origen</Table.Th>
                <Table.Th>Inicio</Table.Th>
                <Table.Th>Duracion</Table.Th>
                <Table.Th>Trafico</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.isLoading && !items.length && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Center h={120}>
                      <Loader />
                    </Center>
                  </Table.Td>
                </Table.Tr>
              )}
              <SessionRows items={items} />
              {!q.isLoading && !items.length && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <EmptyState
                      icon={<IconHistory size={22} />}
                      title="Sin sesiones"
                      description="Ningun registro de accounting coincide con esos filtros."
                    />
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SectionCard>
    </Stack>
  );
}

export function SessionsPage() {
  return (
    <Stack gap="lg">
      <PageHeader title="Sesiones" subtitle="Datos de accounting (radacct)" />
      <Tabs defaultValue="active">
        <Tabs.List mb="md">
          <Tabs.Tab value="active">Activas</Tabs.Tab>
          <Tabs.Tab value="history">Historial</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="active">
          <ActiveTab />
        </Tabs.Panel>
        <Tabs.Panel value="history">
          <HistoryTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
