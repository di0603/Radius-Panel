import {
  Badge,
  Button,
  Card,
  Center,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import {
  IconCircleCheck,
  IconCircleX,
  IconEdit,
  IconHistory,
  IconKey,
  IconPlugConnected,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useUser, useUserActivity } from '../api/hooks';
import { formatBytes, formatDateTime, formatDuration, formatNumber } from '../lib/format';
import { EmptyState } from './EmptyState';

interface Props {
  username: string | null;
  onClose: () => void;
  onEdit: (username: string) => void;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="sm">
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
        {label}
      </Text>
      <Text fw={700} fz="lg" lh={1.3}>
        {value}
      </Text>
    </Card>
  );
}

function AttrTable({ rows }: { rows: { attribute: string; op: string; value: string }[] }) {
  if (!rows.length) {
    return (
      <Text size="sm" c="dimmed" py="sm">
        Sin atributos.
      </Text>
    );
  }
  return (
    <Table withRowBorders={false} verticalSpacing="xs">
      <Table.Tbody>
        {rows.map((r, i) => (
          <Table.Tr key={`${r.attribute}-${i}`}>
            <Table.Td fw={550}>{r.attribute}</Table.Td>
            <Table.Td className="mono" w={50}>
              {r.op}
            </Table.Td>
            <Table.Td className="mono">{r.value}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** Ficha lateral de un usuario: atributos, grupos, sesiones e intentos de acceso. */
export function UserDrawer({ username, onClose, onEdit }: Props) {
  const detail = useUser(username);
  const activity = useUserActivity(username);
  const totals = activity.data?.totals;

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
          {detail.data && (
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconEdit size={13} />}
              onClick={() => username && onEdit(username)}
            >
              Editar
            </Button>
          )}
        </Group>
      }
    >
      {detail.isLoading || activity.isLoading ? (
        <Center h={200}>
          <Loader />
        </Center>
      ) : (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
            <Metric label="Sesiones" value={formatNumber(totals?.sessions ?? 0)} />
            <Metric label="Trafico" value={formatBytes(totals?.bytes ?? 0)} />
            <Metric label="Tiempo" value={formatDuration(totals?.seconds ?? 0)} />
            <Metric
              label="Accept / Reject"
              value={`${formatNumber(totals?.accepts ?? 0)} / ${formatNumber(totals?.rejects ?? 0)}`}
            />
          </SimpleGrid>

          <Tabs defaultValue="sessions">
            <Tabs.List>
              <Tabs.Tab value="sessions" leftSection={<IconPlugConnected size={14} />}>
                Sesiones
              </Tabs.Tab>
              <Tabs.Tab value="auths" leftSection={<IconHistory size={14} />}>
                Autenticaciones
              </Tabs.Tab>
              <Tabs.Tab value="attrs" leftSection={<IconKey size={14} />}>
                Atributos
              </Tabs.Tab>
              <Tabs.Tab value="groups" leftSection={<IconUsersGroup size={14} />}>
                Grupos
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="sessions" pt="sm">
              {activity.data?.sessions.length ? (
                <Table.ScrollContainer minWidth={520}>
                  <Table>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Inicio</Table.Th>
                        <Table.Th>Duracion</Table.Th>
                        <Table.Th>NAS</Table.Th>
                        <Table.Th ta="right">Trafico</Table.Th>
                        <Table.Th>Cierre</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {activity.data.sessions.map((s) => (
                        <Table.Tr key={s.acctuniqueid}>
                          <Table.Td style={{ whiteSpace: 'nowrap' }}>
                            {formatDateTime(s.acctstarttime)}
                          </Table.Td>
                          <Table.Td>{formatDuration(s.acctsessiontime)}</Table.Td>
                          <Table.Td className="mono">{s.nasipaddress || '—'}</Table.Td>
                          <Table.Td ta="right">{formatBytes(s.bytes)}</Table.Td>
                          <Table.Td>
                            {s.acctstoptime ? (
                              <Text size="xs" c="dimmed">
                                {s.acctterminatecause || 'cerrada'}
                              </Text>
                            ) : (
                              <Badge size="sm" variant="light" color="teal">
                                abierta
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
                  icon={<IconPlugConnected size={22} />}
                  title="Sin sesiones"
                  description="Este usuario todavia no tiene accounting registrado."
                />
              )}
            </Tabs.Panel>

            <Tabs.Panel value="auths" pt="sm">
              {activity.data?.auths.length ? (
                <Table>
                  <Table.Tbody>
                    {activity.data.auths.map((a, i) => (
                      <Table.Tr key={`${a.authdate}-${i}`}>
                        <Table.Td w={40}>
                          {a.accepted ? (
                            <IconCircleCheck size={18} color="var(--mantine-color-teal-6)" />
                          ) : (
                            <IconCircleX size={18} color="var(--mantine-color-red-6)" />
                          )}
                        </Table.Td>
                        <Table.Td>{a.reply}</Table.Td>
                        <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                          <Text size="xs" c="dimmed">
                            {formatDateTime(a.authdate)}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : (
                <EmptyState
                  icon={<IconHistory size={22} />}
                  title="Sin intentos de autenticacion"
                  description="Nada en radpostauth para este usuario."
                />
              )}
            </Tabs.Panel>

            <Tabs.Panel value="attrs" pt="sm">
              <Stack gap="md">
                <div>
                  <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
                    Check
                  </Text>
                  <AttrTable rows={detail.data?.checks ?? []} />
                </div>
                <div>
                  <Text size="xs" fw={650} c="dimmed" tt="uppercase" mb={4}>
                    Reply
                  </Text>
                  <AttrTable rows={detail.data?.replies ?? []} />
                </div>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="groups" pt="sm">
              {detail.data?.groups.length ? (
                <Group gap="xs">
                  {detail.data.groups.map((g) => (
                    <Badge key={g.groupname} variant="light">
                      {g.groupname} · prioridad {g.priority}
                    </Badge>
                  ))}
                </Group>
              ) : (
                <Text size="sm" c="dimmed" py="sm">
                  No pertenece a ningun grupo.
                </Text>
              )}
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
    </Drawer>
  );
}
