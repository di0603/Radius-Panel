import { useState, type ReactNode } from 'react';
import {
  Card,
  Group,
  RingProgress,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  ThemeIcon,
  useMantineTheme,
} from '@mantine/core';
import {
  IconActivity,
  IconCircleCheck,
  IconCircleX,
  IconTargetArrow,
  IconUsers,
} from '@tabler/icons-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  useAuthFailures,
  useInactiveUsers,
  useOverview,
  useTerminateCauses,
  useTopNas,
  useTopUsers,
} from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatShortDate,
} from '../lib/format';

/* ------------------------------ Piezas UI ------------------------------- */

function StatCard({
  label,
  value,
  hint,
  icon,
  color,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: ReactNode;
  color: string;
}) {
  return (
    <Card>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
            {label}
          </Text>
          <Text fw={700} fz={28} lh={1.15} style={{ letterSpacing: '-0.02em' }}>
            {value}
          </Text>
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </Stack>
        <ThemeIcon variant="light" color={color} size={40} radius="md">
          {icon}
        </ThemeIcon>
      </Group>
    </Card>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <Group gap={6} wrap="nowrap">
      <span
        style={{ width: 8, height: 8, borderRadius: 3, background: color, display: 'block' }}
      />
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Group>
  );
}

interface TooltipEntry {
  name?: string | number;
  value?: string | number;
  color?: string;
}

function ChartTooltip({
  active,
  label,
  payload,
  suffix,
}: {
  active?: boolean;
  label?: string | number;
  payload?: TooltipEntry[];
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <Text size="xs" fw={650} mb={6}>
        {formatShortDate(String(label))}
      </Text>
      <Stack gap={3}>
        {payload.map((entry, i) => (
          <Group key={i} gap={8} justify="space-between" wrap="nowrap">
            <Group gap={6} wrap="nowrap">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 3,
                  background: entry.color,
                  display: 'block',
                }}
              />
              <Text size="xs" c="dimmed">
                {entry.name}
              </Text>
            </Group>
            <Text size="xs" fw={600}>
              {typeof entry.value === 'number' ? formatNumber(entry.value) : entry.value}
              {suffix ?? ''}
            </Text>
          </Group>
        ))}
      </Stack>
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <Table.Tr>
      <Table.Td colSpan={colSpan}>
        <Text c="dimmed" size="sm" py="xs">
          {text}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

/* ------------------------------- Pagina --------------------------------- */

export function DashboardPage() {
  const [days, setDays] = useState('30');
  const d = Number(days);
  const theme = useMantineTheme();

  const overview = useOverview(d);
  const topUsers = useTopUsers({ days: d, metric: 'traffic', limit: 10 });
  const failures = useAuthFailures({ days: d, limit: 10 });
  const causes = useTerminateCauses(d);
  const topNas = useTopNas(d);
  const inactive = useInactiveUsers({ days: Math.max(d, 30), limit: 10 });

  const accentSecondary = String(theme.other.accentSecondary ?? theme.colors.grape[5]);
  const colorAccepts = theme.colors.teal[6];
  const colorRejects = theme.colors.red[6];
  const colorUp = theme.colors.brand[5];
  const colorDown = accentSecondary;

  const totals = overview.data?.totals;
  const attempts = (totals?.accepts ?? 0) + (totals?.rejects ?? 0);
  const successRate = attempts ? ((totals?.accepts ?? 0) / attempts) * 100 : 0;
  const rateColor = successRate >= 95 ? 'teal' : successRate >= 80 ? 'yellow' : 'red';

  return (
    <Stack gap="lg">
      <PageHeader
        title="Panel"
        subtitle={`Resumen de los ultimos ${d} dias`}
        actions={
          <SegmentedControl
            value={days}
            onChange={setDays}
            data={[
              { label: '7 d', value: '7' },
              { label: '30 d', value: '30' },
              { label: '90 d', value: '90' },
            ]}
          />
        }
      />

      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 5 }} spacing="md">
        {overview.isLoading || !totals ? (
          Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={104} radius="lg" />)
        ) : (
          <>
            <StatCard
              label="Usuarios"
              value={formatNumber(totals.users)}
              hint="dados de alta en RADIUS"
              icon={<IconUsers size={21} stroke={1.7} />}
              color="brand"
            />
            <StatCard
              label="Sesiones activas"
              value={formatNumber(totals.activeSessions)}
              hint="ahora mismo"
              icon={<IconActivity size={21} stroke={1.7} />}
              color="teal"
            />
            <StatCard
              label={`Accepts (${d} d)`}
              value={formatNumber(totals.accepts)}
              hint="autenticaciones correctas"
              icon={<IconCircleCheck size={21} stroke={1.7} />}
              color="green"
            />
            <StatCard
              label={`Rejects (${d} d)`}
              value={formatNumber(totals.rejects)}
              hint="autenticaciones rechazadas"
              icon={<IconCircleX size={21} stroke={1.7} />}
              color="red"
            />
            <Card>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={2}>
                  <Text
                    size="xs"
                    c="dimmed"
                    fw={600}
                    tt="uppercase"
                    style={{ letterSpacing: '0.05em' }}
                  >
                    Tasa de exito
                  </Text>
                  <Text fw={700} fz={28} lh={1.15} style={{ letterSpacing: '-0.02em' }}>
                    {attempts ? formatPercent(successRate) : '—'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {formatNumber(attempts)} intentos
                  </Text>
                </Stack>
                {attempts ? (
                  <RingProgress
                    size={62}
                    thickness={7}
                    roundCaps
                    sections={[{ value: successRate, color: rateColor }]}
                  />
                ) : (
                  <ThemeIcon variant="light" color="gray" size={40} radius="md">
                    <IconTargetArrow size={21} stroke={1.7} />
                  </ThemeIcon>
                )}
              </Group>
            </Card>
          </>
        )}
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <SectionCard
          title="Autenticaciones por dia"
          subtitle={`Ultimos ${d} dias`}
          actions={
            <Group gap="md">
              <LegendDot color={colorAccepts} label="Accepts" />
              <LegendDot color={colorRejects} label="Rejects" />
            </Group>
          }
        >
          {overview.isLoading ? (
            <Skeleton height={260} radius="md" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={overview.data?.loginsByDay ?? []}>
                <defs>
                  <linearGradient id="fillAccepts" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colorAccepts} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={colorAccepts} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="fillRejects" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colorRejects} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={colorRejects} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatShortDate}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis tickLine={false} axisLine={false} allowDecimals={false} width={40} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: colorUp, strokeWidth: 1 }} />
                <Area
                  type="monotone"
                  dataKey="accepts"
                  name="Accepts"
                  stroke={colorAccepts}
                  strokeWidth={2}
                  fill="url(#fillAccepts)"
                />
                <Area
                  type="monotone"
                  dataKey="rejects"
                  name="Rejects"
                  stroke={colorRejects}
                  strokeWidth={2}
                  fill="url(#fillRejects)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </SectionCard>

        <SectionCard
          title="Trafico por dia"
          subtitle="Gigabytes acumulados"
          actions={
            <Group gap="md">
              <LegendDot color={colorUp} label="Subida" />
              <LegendDot color={colorDown} label="Bajada" />
            </Group>
          }
        >
          {overview.isLoading ? (
            <Skeleton height={260} radius="md" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={overview.data?.trafficByDay ?? []} barGap={2}>
                <CartesianGrid strokeDasharray="4 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatShortDate}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  content={<ChartTooltip suffix=" GB" />}
                  cursor={{ fill: 'var(--app-hover)' }}
                />
                <Bar dataKey="inputGb" name="Subida" fill={colorUp} radius={[4, 4, 0, 0]} />
                <Bar dataKey="outputGb" name="Bajada" fill={colorDown} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <SectionCard title="Top usuarios por trafico" bodyPadding={false}>
          <Table.ScrollContainer minWidth={420}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Usuario</Table.Th>
                  <Table.Th>Total</Table.Th>
                  <Table.Th>Tiempo</Table.Th>
                  <Table.Th ta="right">Sesiones</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {topUsers.data?.map((u) => (
                  <Table.Tr key={u.username}>
                    <Table.Td fw={500}>{u.username}</Table.Td>
                    <Table.Td>{formatBytes(u.inputOctets + u.outputOctets)}</Table.Td>
                    <Table.Td>{formatDuration(u.sessionTime)}</Table.Td>
                    <Table.Td ta="right">{u.sessions}</Table.Td>
                  </Table.Tr>
                ))}
                {!topUsers.isLoading && !topUsers.data?.length && (
                  <EmptyRow colSpan={4} text="Sin datos de accounting en el periodo." />
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </SectionCard>

        <SectionCard title="Fallos de autenticacion" bodyPadding={false}>
          <Table.ScrollContainer minWidth={420}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Usuario</Table.Th>
                  <Table.Th ta="right">Fallos</Table.Th>
                  <Table.Th>Ultimo</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {failures.data?.map((f) => (
                  <Table.Tr key={f.username}>
                    <Table.Td fw={500}>{f.username || '(vacio)'}</Table.Td>
                    <Table.Td ta="right">{f.failures}</Table.Td>
                    <Table.Td>{formatDateTime(f.lastAt)}</Table.Td>
                  </Table.Tr>
                ))}
                {!failures.isLoading && !failures.data?.length && (
                  <EmptyRow colSpan={3} text="Sin rechazos en el periodo." />
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </SectionCard>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
        <SectionCard title="Motivos de cierre" bodyPadding={false}>
          <Table>
            <Table.Tbody>
              {causes.data?.map((c) => (
                <Table.Tr key={c.cause}>
                  <Table.Td>{c.cause}</Table.Td>
                  <Table.Td ta="right" fw={500}>
                    {formatNumber(c.count)}
                  </Table.Td>
                </Table.Tr>
              ))}
              {!causes.isLoading && !causes.data?.length && (
                <EmptyRow colSpan={2} text="Sin datos." />
              )}
            </Table.Tbody>
          </Table>
        </SectionCard>

        <SectionCard title="Top NAS" bodyPadding={false}>
          <Table.ScrollContainer minWidth={320}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>NAS</Table.Th>
                  <Table.Th ta="right">Ses.</Table.Th>
                  <Table.Th ta="right">Usr.</Table.Th>
                  <Table.Th ta="right">GB</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {topNas.data?.map((n) => (
                  <Table.Tr key={n.nasipaddress}>
                    <Table.Td className="mono">{n.nasipaddress}</Table.Td>
                    <Table.Td ta="right">{n.sessions}</Table.Td>
                    <Table.Td ta="right">{n.users}</Table.Td>
                    <Table.Td ta="right">{n.gb.toFixed(1)}</Table.Td>
                  </Table.Tr>
                ))}
                {!topNas.isLoading && !topNas.data?.length && (
                  <EmptyRow colSpan={4} text="Sin datos." />
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </SectionCard>

        <SectionCard title="Usuarios inactivos" subtitle="Sin autenticar en 30+ dias" bodyPadding={false}>
          <Table>
            <Table.Tbody>
              {inactive.data?.map((u) => (
                <Table.Tr key={u.username}>
                  <Table.Td>{u.username}</Table.Td>
                  <Table.Td ta="right">
                    <Text size="xs" c="dimmed">
                      {u.lastAuth ? formatDateTime(u.lastAuth) : 'nunca'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
              {!inactive.isLoading && !inactive.data?.length && (
                <EmptyRow colSpan={2} text="Ninguno." />
              )}
            </Table.Tbody>
          </Table>
        </SectionCard>
      </SimpleGrid>
    </Stack>
  );
}
