import {
  AppShell,
  Avatar,
  Badge,
  Burger,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  rem,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconChartBar,
  IconHistory,
  IconLogout,
  IconPlugConnected,
  IconRadar2,
  IconReportAnalytics,
  IconRouter,
  IconShieldLock,
  IconUserCog,
  IconUsers,
  IconUsersGroup,
} from '@tabler/icons-react';
import { NavLink as RouterNavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useMeta } from '../api/hooks';
import { ThemeSwitcher } from './ThemeSwitcher';

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconChartBar;
  end?: boolean;
}

const NAV_SECTIONS: { label: string; adminOnly?: boolean; items: NavItem[] }[] = [
  {
    label: 'General',
    items: [
      { to: '/', label: 'Panel', icon: IconChartBar, end: true },
      { to: '/reports', label: 'Reportes', icon: IconReportAnalytics },
    ],
  },
  {
    label: 'RADIUS',
    items: [
      { to: '/users', label: 'Usuarios', icon: IconUsers },
      { to: '/groups', label: 'Grupos y perfiles', icon: IconUsersGroup },
      { to: '/sessions', label: 'Sesiones', icon: IconPlugConnected },
      { to: '/nas', label: 'NAS / clientes', icon: IconRouter },
    ],
  },
  {
    label: 'Sistema',
    adminOnly: true,
    items: [
      { to: '/admins', label: 'Administradores', icon: IconShieldLock },
      { to: '/audit', label: 'Auditoria', icon: IconHistory },
    ],
  },
];

export function AppLayout() {
  const [opened, { toggle, close }] = useDisclosure();
  const { user, logout, hasRole } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const meta = useMeta();

  const dbState = meta.data ? (meta.data.dbOk ? 'ok' : 'error') : 'unknown';
  const sections = NAV_SECTIONS.filter((s) => !s.adminOnly || hasRole('admin'));

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 268, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <div className="brand-mark">
              <IconRadar2 size={19} stroke={1.8} />
            </div>
            <div>
              <Text className="brand-name" lh={1.15}>
                Radius Panel
              </Text>
              <Text size="10px" c="dimmed" lh={1.2} visibleFrom="xs">
                Administracion FreeRADIUS
              </Text>
            </div>
          </Group>

          <Group gap="xs" wrap="nowrap">
            <ThemeSwitcher />
            <Menu shadow="md" width={220} position="bottom-end" withinPortal>
              <Menu.Target>
                <Group
                  gap="xs"
                  wrap="nowrap"
                  style={{ cursor: 'pointer' }}
                  px={6}
                  py={4}
                  role="button"
                  tabIndex={0}
                  aria-label="Menu de usuario"
                >
                  <Avatar radius="xl" size={30} variant="gradient">
                    {user?.username?.[0]?.toUpperCase()}
                  </Avatar>
                  <div style={{ lineHeight: 1.15 }}>
                    <Text size="sm" fw={600} visibleFrom="sm">
                      {user?.username}
                    </Text>
                    <Text size="10px" c="dimmed" visibleFrom="sm">
                      {user?.role}
                    </Text>
                  </div>
                </Group>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  <Group gap={6}>
                    Sesion
                    <Badge
                      size="xs"
                      variant="light"
                      color={user?.role === 'admin' ? 'brand' : 'gray'}
                    >
                      {user?.role}
                    </Badge>
                  </Group>
                </Menu.Label>
                <Menu.Item
                  leftSection={<IconUserCog style={{ width: rem(16), height: rem(16) }} />}
                  onClick={() => navigate('/account')}
                >
                  Mi cuenta y seguridad
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout style={{ width: rem(16), height: rem(16) }} />}
                  onClick={async () => {
                    await logout();
                    navigate('/login');
                  }}
                >
                  Cerrar sesion
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea} type="scroll">
          <Stack gap={2}>
            {sections.map((section) => (
              <div key={section.label}>
                <div className="nav-section-label">{section.label}</div>
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    component={RouterNavLink}
                    to={item.to}
                    end={item.end}
                    active={item.end ? pathname === item.to : pathname.startsWith(item.to)}
                    label={item.label}
                    leftSection={<item.icon size={18} stroke={1.7} />}
                    onClick={close}
                  />
                ))}
              </div>
            ))}
          </Stack>
        </AppShell.Section>

        <AppShell.Section>
          <Tooltip
            label={
              dbState === 'ok'
                ? 'Conexion con las bases de datos correcta'
                : dbState === 'error'
                  ? 'Alguna base de datos no responde'
                  : 'Comprobando estado...'
            }
            position="top"
          >
            <Group gap={8} px="sm" py={10} wrap="nowrap" style={{ cursor: 'default' }}>
              <span className="status-dot" data-state={dbState} />
              <Text size="xs" c="dimmed">
                v{meta.data?.version ?? '—'} · BD{' '}
                {dbState === 'unknown' ? '…' : dbState === 'ok' ? 'ok' : 'error'}
              </Text>
            </Group>
          </Tooltip>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <div className="page-enter" key={pathname}>
          <Outlet />
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
