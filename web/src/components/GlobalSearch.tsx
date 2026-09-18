import { useMemo, useState } from 'react';
import { Button, Kbd, Group, rem } from '@mantine/core';
import { useDebouncedValue, useOs } from '@mantine/hooks';
import { Spotlight, spotlight, type SpotlightActionData } from '@mantine/spotlight';
import {
  IconChartBar,
  IconHistory,
  IconPlugConnected,
  IconReportAnalytics,
  IconRouter,
  IconSearch,
  IconShieldLock,
  IconUserCog,
  IconUsers,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useGroups, useNasList, useUsers } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';

const ICON = { style: { width: rem(18), height: rem(18) } };

/**
 * Buscador global (Ctrl/Cmd + K). Mezcla las paginas del panel con resultados
 * en vivo de usuarios, grupos y NAS para poder saltar directamente.
 */
export function GlobalSearch() {
  const navigate = useNavigate();
  const { hasRole } = useAuth();
  const [query, setQuery] = useState('');
  const [debounced] = useDebouncedValue(query.trim(), 250);
  const os = useOs();

  const searching = debounced.length >= 2;
  const users = useUsers({ search: searching ? debounced : '', limit: 5, offset: 0 });
  const groups = useGroups();
  const nas = useNasList();

  const actions = useMemo<SpotlightActionData[]>(() => {
    const pages: SpotlightActionData[] = [
      {
        id: 'page-dashboard',
        label: 'Panel',
        description: 'Resumen y graficas',
        leftSection: <IconChartBar {...ICON} />,
        onClick: () => navigate('/'),
        group: 'Paginas',
      },
      {
        id: 'page-reports',
        label: 'Reportes',
        description: 'Heatmap, concurrencia y anomalias',
        leftSection: <IconReportAnalytics {...ICON} />,
        onClick: () => navigate('/reports'),
        group: 'Paginas',
      },
      {
        id: 'page-users',
        label: 'Usuarios',
        description: 'Cuentas RADIUS',
        leftSection: <IconUsers {...ICON} />,
        onClick: () => navigate('/users'),
        group: 'Paginas',
      },
      {
        id: 'page-groups',
        label: 'Grupos y perfiles',
        leftSection: <IconUsersGroup {...ICON} />,
        onClick: () => navigate('/groups'),
        group: 'Paginas',
      },
      {
        id: 'page-sessions',
        label: 'Sesiones',
        description: 'Activas e historial',
        leftSection: <IconPlugConnected {...ICON} />,
        onClick: () => navigate('/sessions'),
        group: 'Paginas',
      },
      {
        id: 'page-nas',
        label: 'NAS / clientes',
        leftSection: <IconRouter {...ICON} />,
        onClick: () => navigate('/nas'),
        group: 'Paginas',
      },
      {
        id: 'page-account',
        label: 'Mi cuenta y seguridad',
        description: '2FA, contrasena y sesiones',
        leftSection: <IconUserCog {...ICON} />,
        onClick: () => navigate('/account'),
        group: 'Paginas',
      },
    ];

    if (hasRole('admin')) {
      pages.push(
        {
          id: 'page-admins',
          label: 'Administradores',
          leftSection: <IconShieldLock {...ICON} />,
          onClick: () => navigate('/admins'),
          group: 'Paginas',
        },
        {
          id: 'page-audit',
          label: 'Auditoria',
          leftSection: <IconHistory {...ICON} />,
          onClick: () => navigate('/audit'),
          group: 'Paginas',
        },
      );
    }

    if (!searching) return pages;

    const needle = debounced.toLowerCase();

    const userActions: SpotlightActionData[] = (users.data?.items ?? []).map((u) => ({
      id: `user-${u.username}`,
      label: u.username,
      description: u.disabled ? 'Usuario desactivado' : u.groups.join(', ') || 'Sin grupos',
      leftSection: <IconUsers {...ICON} />,
      onClick: () => navigate(`/users?q=${encodeURIComponent(u.username)}`),
      group: 'Usuarios',
    }));

    const groupActions: SpotlightActionData[] = (groups.data ?? [])
      .filter((g) => g.groupname.toLowerCase().includes(needle))
      .slice(0, 5)
      .map((g) => ({
        id: `group-${g.groupname}`,
        label: g.groupname,
        description: `${g.memberCount} usuario(s)`,
        leftSection: <IconUsersGroup {...ICON} />,
        onClick: () => navigate('/groups'),
        group: 'Grupos',
      }));

    const nasActions: SpotlightActionData[] = (nas.data ?? [])
      .filter(
        (n) =>
          n.nasname.toLowerCase().includes(needle) ||
          (n.shortname ?? '').toLowerCase().includes(needle),
      )
      .slice(0, 5)
      .map((n) => ({
        id: `nas-${n.id}`,
        label: n.nasname,
        description: n.shortname ?? n.description ?? 'NAS',
        leftSection: <IconRouter {...ICON} />,
        onClick: () => navigate('/nas'),
        group: 'NAS',
      }));

    return [...pages, ...userActions, ...groupActions, ...nasActions];
  }, [navigate, hasRole, searching, debounced, users.data, groups.data, nas.data]);

  return (
    <>
      <Button
        variant="default"
        size="xs"
        onClick={spotlight.open}
        leftSection={<IconSearch size={14} stroke={1.8} />}
        visibleFrom="sm"
        styles={{ label: { fontWeight: 500 } }}
      >
        <Group gap={8} wrap="nowrap">
          <span style={{ color: 'var(--mantine-color-dimmed)' }}>Buscar</span>
          <Kbd size="xs">{os === 'macos' ? '⌘' : 'Ctrl'} K</Kbd>
        </Group>
      </Button>

      <Spotlight
        actions={actions}
        query={query}
        onQueryChange={setQuery}
        shortcut={['mod + K', '/']}
        nothingFound="Nada coincide con la busqueda"
        highlightQuery
        limit={20}
        scrollable
        searchProps={{
          leftSection: <IconSearch {...ICON} />,
          placeholder: 'Buscar paginas, usuarios, grupos o NAS...',
        }}
      />
    </>
  );
}
