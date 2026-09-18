import { useState } from 'react';
import {
  Badge,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconDownload, IconHistory, IconSearch } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useAuditLog } from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { downloadCsv } from '../lib/csv';
import { formatDateTime } from '../lib/format';

const PAGE = 50;

const ACTION_COLOR: Record<string, string> = {
  create: 'teal',
  update: 'blue',
  delete: 'red',
  disconnect: 'orange',
  login: 'grape',
};

export function AuditPage() {
  const [entity, setEntity] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [admin, setAdmin] = useState('');
  const [page, setPage] = useState(1);

  const q = useAuditLog({
    entity: entity ?? undefined,
    action: action ?? undefined,
    admin: admin || undefined,
    limit: PAGE,
    offset: (page - 1) * PAGE,
  });
  const totalPages = Math.max(1, Math.ceil((q.data?.total ?? 0) / PAGE));

  return (
    <Stack gap="lg">
      <PageHeader
        title="Auditoria"
        subtitle={`${q.data?.total ?? 0} operaciones registradas`}
        actions={
          <Button
            variant="default"
            leftSection={<IconDownload size={16} />}
            disabled={!q.data?.items.length}
            onClick={() =>
              downloadCsv(
                `auditoria-${dayjs().format('YYYYMMDD-HHmm')}`,
                (q.data?.items ?? []).map((e) => ({
                  fecha: e.created_at,
                  admin: e.admin_name,
                  accion: e.action,
                  entidad: e.entity,
                  id: e.entity_id,
                  ip: e.ip,
                  detalle: e.detail ? JSON.stringify(e.detail) : '',
                })),
              )
            }
          >
            Exportar
          </Button>
        }
      />

      <SectionCard
        title="Registro de operaciones"
        subtitle="Tabla panel_audit_log"
        actions={
          <Group gap="xs" wrap="wrap">
            <Select
              placeholder="Entidad"
              clearable
              size="xs"
              w={150}
              data={['user', 'user-groups', 'group', 'nas', 'session', 'admin']}
              value={entity}
              onChange={(v) => {
                setEntity(v);
                setPage(1);
              }}
            />
            <Select
              placeholder="Accion"
              clearable
              size="xs"
              w={140}
              data={['create', 'update', 'delete', 'disconnect', 'login']}
              value={action}
              onChange={(v) => {
                setAction(v);
                setPage(1);
              }}
            />
            <TextInput
              placeholder="Administrador"
              size="xs"
              w={160}
              leftSection={<IconSearch size={14} />}
              value={admin}
              onChange={(e) => {
                setAdmin(e.currentTarget.value);
                setPage(1);
              }}
            />
          </Group>
        }
        bodyPadding={false}
        footer={
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {q.data?.total ?? 0} entradas
            </Text>
            <Pagination value={page} onChange={setPage} total={totalPages} />
          </Group>
        }
      >
        <Table.ScrollContainer minWidth={820}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Fecha</Table.Th>
                <Table.Th>Admin</Table.Th>
                <Table.Th>Accion</Table.Th>
                <Table.Th>Entidad</Table.Th>
                <Table.Th>Detalle</Table.Th>
                <Table.Th>IP</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.isLoading && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Center h={120}>
                      <Loader />
                    </Center>
                  </Table.Td>
                </Table.Tr>
              )}
              {q.data?.items.map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>
                    {formatDateTime(e.created_at)}
                  </Table.Td>
                  <Table.Td fw={550}>{e.admin_name}</Table.Td>
                  <Table.Td>
                    <Badge color={ACTION_COLOR[e.action] ?? 'gray'} variant="light" size="sm">
                      {e.action}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    {e.entity}{' '}
                    <Text span c="dimmed">
                      #{e.entity_id}
                    </Text>
                  </Table.Td>
                  <Table.Td maw={320}>
                    {e.detail ? (
                      <Code block style={{ maxHeight: 120, overflow: 'auto' }}>
                        {JSON.stringify(e.detail, null, 1)}
                      </Code>
                    ) : (
                      '—'
                    )}
                  </Table.Td>
                  <Table.Td className="mono">{e.ip}</Table.Td>
                </Table.Tr>
              ))}
              {q.data && !q.data.items.length && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <EmptyState
                      icon={<IconHistory size={22} />}
                      title="Sin entradas"
                      description="No hay operaciones que coincidan con los filtros aplicados."
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
