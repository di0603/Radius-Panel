import { useState } from 'react';
import {
  Badge,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconArrowDownRight,
  IconArrowRight,
  IconArrowUpRight,
  IconRouter,
} from '@tabler/icons-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  useAnomalies,
  useConcurrency,
  useHeatmap,
  useNasStats,
  usePeriodComparison,
  useSessionDurations,
} from '../api/hooks';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import type { Anomaly, PeriodMetric } from '../api/types';
import { formatDateTime, formatNumber, formatShortDate } from '../lib/format';

/* --------------------------- Comparativa --------------------------- */

function trendColor(metric: PeriodMetric): string {
  if (metric.changePct === null) return 'gray';
  const isBad = metric.label === 'Rechazos';
  if (Math.abs(metric.changePct) < 1) return 'gray';
  const up = metric.changePct > 0;
  return up === isBad ? 'red' : 'teal';
}

function MetricCard({ metric }: { metric: PeriodMetric }) {
  const color = trendColor(metric);
  const pct = metric.changePct;
  const Icon =
    pct === null || Math.abs(pct) < 1
      ? IconArrowRight
      : pct > 0
        ? IconArrowUpRight
        : IconArrowDownRight;
  const decimals = metric.label.includes('GB') ? 1 : 0;

  return (
    <Card>
      <Stack gap={4}>
        <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: '0.05em' }}>
          {metric.label}
        </Text>
        <Text fw={700} fz={26} lh={1.15} style={{ letterSpacing: '-0.02em' }}>
          {metric.current.toLocaleString('es-ES', { maximumFractionDigits: decimals })}
        </Text>
        <Group gap={6} wrap="nowrap">
          <Badge
            size="sm"
            variant="light"
            color={color}
            leftSection={<Icon size={12} stroke={2.2} />}
          >
            {pct === null ? 'sin datos previos' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)} %`}
          </Badge>
          <Text size="xs" c="dimmed">
            antes {metric.previous.toLocaleString('es-ES', { maximumFractionDigits: decimals })}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}

/* ----------------------------- Heatmap ----------------------------- */

const WEEKDAY_ORDER = [2, 3, 4, 5, 6, 7, 1];
const WEEKDAY_LABEL: Record<number, string> = {
  1: 'Dom',
  2: 'Lun',
  3: 'Mar',
  4: 'Mie',
  5: 'Jue',
  6: 'Vie',
  7: 'Sab',
};

function Heatmap({ days }: { days: number }) {
  const theme = useMantineTheme();
  const q = useHeatmap(days);

  if (q.isLoading) return <Skeleton height={220} radius="md" />;

  const cells = q.data ?? [];
  if (!cells.length) {
    return (
      <EmptyState
        icon={<IconActivityHeartbeat size={22} />}
        title="Sin autenticaciones en el periodo"
        description="El mapa se rellena con los registros de radpostauth."
      />
    );
  }

  const byKey = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c]));
  const max = Math.max(...cells.map((c) => c.accepts + c.rejects), 1);

  return (
    <Stack gap={6}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 2 }}>
          <tbody>
            {WEEKDAY_ORDER.map((weekday) => (
              <tr key={weekday}>
                <td>
                  <Text size="xs" c="dimmed" pr={6} style={{ whiteSpace: 'nowrap' }}>
                    {WEEKDAY_LABEL[weekday]}
                  </Text>
                </td>
                {Array.from({ length: 24 }, (_, hour) => {
                  const cell = byKey.get(`${weekday}-${hour}`);
                  const total = (cell?.accepts ?? 0) + (cell?.rejects ?? 0);
                  const intensity = total / max;
                  return (
                    <td key={hour}>
                      <Tooltip
                        label={`${WEEKDAY_LABEL[weekday]} ${String(hour).padStart(2, '0')}:00 — ${formatNumber(total)} auth (${formatNumber(cell?.rejects ?? 0)} rechazos)`}
                        withArrow
                      >
                        <div
                          style={{
                            width: 22,
                            height: 20,
                            borderRadius: 4,
                            background:
                              total === 0
                                ? 'var(--app-hover)'
                                : `color-mix(in srgb, ${theme.colors.brand[5]} ${Math.round(18 + intensity * 82)}%, transparent)`,
                          }}
                        />
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td />
              {Array.from({ length: 24 }, (_, hour) => (
                <td key={hour}>
                  <Text size="9px" c="dimmed" ta="center">
                    {hour % 3 === 0 ? hour : ''}
                  </Text>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <Text size="xs" c="dimmed">
        Cuanto mas intenso, mas autenticaciones en esa franja.
      </Text>
    </Stack>
  );
}

/* ---------------------------- Anomalias ---------------------------- */

const ANOMALY_META: Record<Anomaly['kind'], { label: string; color: string }> = {
  'long-session': { label: 'sesion larga', color: 'orange' },
  'heavy-traffic': { label: 'trafico alto', color: 'grape' },
  flapping: { label: 'reconexiones', color: 'red' },
};

/* ------------------------------ Pagina ----------------------------- */

export function ReportsPage() {
  const [days, setDays] = useState('30');
  const d = Number(days);
  const theme = useMantineTheme();

  const comparison = usePeriodComparison(d);
  const concurrency = useConcurrency(d);
  const durations = useSessionDurations(d);
  const nasStats = useNasStats(d);
  const anomalies = useAnomalies({ days: d, limit: 10 });

  return (
    <Stack gap="lg">
      <PageHeader
        title="Reportes"
        subtitle={`Analitica de los ultimos ${d} dias`}
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

      <SectionCard
        title="Comparativa con el periodo anterior"
        subtitle={`Ultimos ${d} dias frente a los ${d} dias previos`}
      >
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 5 }} spacing="md">
          {comparison.isLoading
            ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} height={104} radius="lg" />)
            : comparison.data?.map((m) => <MetricCard key={m.label} metric={m} />)}
        </SimpleGrid>
      </SectionCard>

      <SectionCard
        title="Uso por franja horaria"
        subtitle="Autenticaciones por hora y dia de la semana"
      >
        <Heatmap days={d} />
      </SectionCard>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <SectionCard title="Concurrencia maxima" subtitle="Pico de sesiones simultaneas cada dia">
          {concurrency.isLoading ? (
            <Skeleton height={250} radius="md" />
          ) : concurrency.data?.length ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={concurrency.data}>
                <defs>
                  <linearGradient id="fillPeak" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.colors.brand[5]} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={theme.colors.brand[5]} stopOpacity={0} />
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
                <RechartsTooltip
                  formatter={(value: number) => [`${formatNumber(value)} sesiones`, 'Pico']}
                  labelFormatter={(label) => formatShortDate(String(label))}
                />
                <Area
                  type="monotone"
                  dataKey="peak"
                  stroke={theme.colors.brand[5]}
                  strokeWidth={2}
                  fill="url(#fillPeak)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              icon={<IconActivityHeartbeat size={22} />}
              title="Sin sesiones en el periodo"
              description="Hace falta accounting en radacct para calcular el pico."
            />
          )}
        </SectionCard>

        <SectionCard
          title="Duracion de las sesiones"
          subtitle="Muchas sesiones cortas suelen indicar un problema de enlace"
        >
          {durations.isLoading ? (
            <Skeleton height={250} radius="md" />
          ) : (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={durations.data ?? []} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="4 4" horizontal={false} />
                <XAxis type="number" tickLine={false} axisLine={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  width={90}
                />
                <RechartsTooltip
                  formatter={(value: number) => [`${formatNumber(value)} sesiones`, '']}
                  cursor={{ fill: 'var(--app-hover)' }}
                />
                <Bar dataKey="sessions" fill={theme.colors.brand[5]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </SectionCard>
      </SimpleGrid>

      <SectionCard
        title="Actividad por NAS"
        subtitle="Tabla radacct agrupada por equipo"
        bodyPadding={false}
      >
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>NAS</Table.Th>
                <Table.Th ta="right">Sesiones</Table.Th>
                <Table.Th ta="right">Usuarios</Table.Th>
                <Table.Th ta="right">Activas</Table.Th>
                <Table.Th ta="right">GB</Table.Th>
                <Table.Th ta="right">Duracion media</Table.Th>
                <Table.Th>Ultimo registro</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {nasStats.data?.map((n) => (
                <Table.Tr key={n.nasipaddress}>
                  <Table.Td className="mono" fw={550}>
                    {n.nasipaddress}
                  </Table.Td>
                  <Table.Td ta="right">{formatNumber(n.sessions)}</Table.Td>
                  <Table.Td ta="right">{formatNumber(n.users)}</Table.Td>
                  <Table.Td ta="right">
                    {n.activeNow > 0 ? (
                      <Badge size="sm" variant="light" color="teal">
                        {n.activeNow}
                      </Badge>
                    ) : (
                      <Text size="xs" c="dimmed">
                        0
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">{n.gb.toFixed(1)}</Table.Td>
                  <Table.Td ta="right">{Math.round(n.avgSessionMinutes)} min</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(n.lastSeen)}</Table.Td>
                </Table.Tr>
              ))}
              {!nasStats.isLoading && !nasStats.data?.length && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <EmptyState
                      icon={<IconRouter size={22} />}
                      title="Sin actividad por NAS"
                      description="No hay sesiones registradas en el periodo elegido."
                    />
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SectionCard>

      <SectionCard
        title="Anomalias detectadas"
        subtitle="Sesiones sin cerrar, consumos extremos y reconexiones en bucle"
        bodyPadding={false}
      >
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tipo</Table.Th>
                <Table.Th>Usuario</Table.Th>
                <Table.Th>NAS</Table.Th>
                <Table.Th>Detalle</Table.Th>
                <Table.Th>Cuando</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {anomalies.data?.map((a, i) => (
                <Table.Tr key={`${a.kind}-${a.username}-${i}`}>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={ANOMALY_META[a.kind].color}>
                      {ANOMALY_META[a.kind].label}
                    </Badge>
                  </Table.Td>
                  <Table.Td fw={550}>{a.username || '(vacio)'}</Table.Td>
                  <Table.Td className="mono">{a.nasipaddress || '—'}</Table.Td>
                  <Table.Td>{a.detail}</Table.Td>
                  <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.at)}</Table.Td>
                </Table.Tr>
              ))}
              {!anomalies.isLoading && !anomalies.data?.length && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <EmptyState
                      icon={<IconAlertTriangle size={22} />}
                      title="Nada raro por aqui"
                      description="No se han detectado sesiones anomalas en el periodo."
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
