import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Input,
  Loader,
  Menu,
  Modal,
  Pagination,
  Paper,
  SegmentedControl,
  Table,
  Tabs,
  Tooltip,
  createTheme,
  rem,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core';

/* ------------------------------- Acentos -------------------------------- */

export interface Accent {
  id: string;
  label: string;
  /** Escala de 10 tonos: 0 el mas claro, 9 el mas oscuro. */
  colors: MantineColorsTuple;
  /** Segundo color, usado en degradados (logo, avatar, auroras del login). */
  secondary: string;
}

export const ACCENTS: Accent[] = [
  {
    id: 'indigo',
    label: 'Indigo',
    secondary: '#a855f7',
    colors: [
      '#eef2ff',
      '#e0e7ff',
      '#c7d2fe',
      '#a5b4fc',
      '#818cf8',
      '#6366f1',
      '#4f46e5',
      '#4338ca',
      '#3730a3',
      '#312e81',
    ],
  },
  {
    id: 'violet',
    label: 'Violeta',
    secondary: '#ec4899',
    colors: [
      '#f5f3ff',
      '#ede9fe',
      '#ddd6fe',
      '#c4b5fd',
      '#a78bfa',
      '#8b5cf6',
      '#7c3aed',
      '#6d28d9',
      '#5b21b6',
      '#4c1d95',
    ],
  },
  {
    id: 'ocean',
    label: 'Oceano',
    secondary: '#06b6d4',
    colors: [
      '#eff6ff',
      '#dbeafe',
      '#bfdbfe',
      '#93c5fd',
      '#60a5fa',
      '#3b82f6',
      '#2563eb',
      '#1d4ed8',
      '#1e40af',
      '#1e3a8a',
    ],
  },
  {
    id: 'emerald',
    label: 'Esmeralda',
    secondary: '#14b8a6',
    colors: [
      '#ecfdf5',
      '#d1fae5',
      '#a7f3d0',
      '#6ee7b7',
      '#34d399',
      '#10b981',
      '#059669',
      '#047857',
      '#065f46',
      '#064e3b',
    ],
  },
  {
    id: 'amber',
    label: 'Ambar',
    secondary: '#f97316',
    colors: [
      '#fffbeb',
      '#fef3c7',
      '#fde68a',
      '#fcd34d',
      '#fbbf24',
      '#f59e0b',
      '#d97706',
      '#b45309',
      '#92400e',
      '#78350f',
    ],
  },
  {
    id: 'rose',
    label: 'Carmesi',
    secondary: '#fb923c',
    colors: [
      '#fff1f2',
      '#ffe4e6',
      '#fecdd3',
      '#fda4af',
      '#fb7185',
      '#f43f5e',
      '#e11d48',
      '#be123c',
      '#9f1239',
      '#881337',
    ],
  },
  {
    id: 'graphite',
    label: 'Grafito',
    secondary: '#94a3b8',
    colors: [
      '#f8fafc',
      '#f1f5f9',
      '#e2e8f0',
      '#cbd5e1',
      '#94a3b8',
      '#64748b',
      '#475569',
      '#334155',
      '#1e293b',
      '#0f172a',
    ],
  },
];

export const DEFAULT_ACCENT = 'indigo';

export function findAccent(id: string | null | undefined): Accent {
  return ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
}

/**
 * Escala neutra del modo oscuro. Mantine la usa asi:
 * 0 = texto, 2 = texto atenuado, 4 = bordes, 6 = superficies "default",
 * 7 = fondo de Paper/Card y de la app.
 */
const dark: MantineColorsTuple = [
  '#c7cddb',
  '#aeb6c8',
  '#8e97ab',
  '#6b7488',
  '#2b3244',
  '#212636',
  '#1a1f2c',
  '#151a25',
  '#0f131c',
  '#090c12',
];

/* -------------------------------- Tema ---------------------------------- */

export function createPanelTheme(accentId: string): MantineThemeOverride {
  const accent = findAccent(accentId);

  return createTheme({
    primaryColor: 'brand',
    primaryShade: { light: 6, dark: 5 },
    autoContrast: true,
    colors: { brand: accent.colors, dark },
    defaultGradient: { from: accent.colors[5], to: accent.secondary, deg: 135 },
    defaultRadius: 'md',
    radius: { xs: rem(6), sm: rem(8), md: rem(10), lg: rem(14), xl: rem(20) },
    fontFamily:
      '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif',
    fontFamilyMonospace:
      'ui-monospace, "Cascadia Code", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace',
    headings: {
      fontFamily:
        '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, -apple-system, sans-serif',
      fontWeight: '680',
      sizes: {
        h1: { fontSize: rem(30), lineHeight: '1.2' },
        h2: { fontSize: rem(23), lineHeight: '1.25' },
        h3: { fontSize: rem(18), lineHeight: '1.3' },
        h4: { fontSize: rem(16), lineHeight: '1.35' },
      },
    },
    shadows: {
      xs: '0 1px 2px rgba(15, 23, 42, 0.06)',
      sm: '0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px -6px rgba(15, 23, 42, 0.12)',
      md: '0 2px 4px rgba(15, 23, 42, 0.06), 0 12px 28px -12px rgba(15, 23, 42, 0.18)',
      lg: '0 4px 8px rgba(15, 23, 42, 0.08), 0 24px 48px -20px rgba(15, 23, 42, 0.25)',
      xl: '0 8px 16px rgba(15, 23, 42, 0.10), 0 40px 80px -28px rgba(15, 23, 42, 0.30)',
    },
    other: { accentSecondary: accent.secondary },
    components: {
      Card: Card.extend({
        defaultProps: { withBorder: true, radius: 'lg', padding: 'lg' },
      }),
      Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
      Table: Table.extend({
        defaultProps: { highlightOnHover: true, verticalSpacing: 'sm', horizontalSpacing: 'md' },
      }),
      Modal: Modal.extend({
        defaultProps: {
          centered: true,
          radius: 'lg',
          overlayProps: { blur: 3, backgroundOpacity: 0.45 },
          transitionProps: { transition: 'pop', duration: 180 },
        },
      }),
      Menu: Menu.extend({
        defaultProps: { radius: 'md', shadow: 'md', transitionProps: { transition: 'pop' } },
      }),
      Input: Input.extend({ defaultProps: { radius: 'md' } }),
      Button: Button.extend({ defaultProps: { radius: 'md' } }),
      ActionIcon: ActionIcon.extend({ defaultProps: { radius: 'md' } }),
      Badge: Badge.extend({ defaultProps: { radius: 'sm' } }),
      Tooltip: Tooltip.extend({ defaultProps: { radius: 'sm', withArrow: true, openDelay: 250 } }),
      Tabs: Tabs.extend({ defaultProps: { keepMounted: false } }),
      Pagination: Pagination.extend({ defaultProps: { radius: 'md', size: 'sm' } }),
      SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'md' } }),
      Loader: Loader.extend({ defaultProps: { type: 'dots' } }),
    },
  });
}

/**
 * Tokens propios del panel. Se resuelven por esquema de color para no tener
 * que duplicar reglas `[data-mantine-color-scheme]` en el CSS.
 */
export const cssVariablesResolver: CSSVariablesResolver = (theme) => ({
  variables: {
    '--app-accent-2': String(theme.other.accentSecondary ?? '#a855f7'),
    '--app-header-height': rem(60),
    '--app-navbar-width': rem(268),
    '--app-transition': '160ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  light: {
    '--app-page-bg': '#f5f6fa',
    '--app-surface': '#ffffff',
    '--app-surface-muted': '#fafbfd',
    '--app-border': 'rgba(15, 23, 42, 0.09)',
    '--app-border-strong': 'rgba(15, 23, 42, 0.16)',
    '--app-hover': 'rgba(15, 23, 42, 0.04)',
    '--app-chrome-bg': 'rgba(255, 255, 255, 0.78)',
    '--app-shadow-card': '0 1px 2px rgba(15, 23, 42, 0.05), 0 8px 24px -16px rgba(15, 23, 42, 0.18)',
    '--app-shadow-raised':
      '0 2px 6px rgba(15, 23, 42, 0.07), 0 18px 40px -20px rgba(15, 23, 42, 0.28)',
    '--app-scrollbar-thumb': 'rgba(15, 23, 42, 0.18)',
  },
  dark: {
    '--app-page-bg': '#0b0e15',
    '--app-surface': '#151a25',
    '--app-surface-muted': '#12161f',
    '--app-border': 'rgba(255, 255, 255, 0.08)',
    '--app-border-strong': 'rgba(255, 255, 255, 0.16)',
    '--app-hover': 'rgba(255, 255, 255, 0.05)',
    '--app-chrome-bg': 'rgba(21, 26, 37, 0.78)',
    '--app-shadow-card': '0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 28px -18px rgba(0, 0, 0, 0.7)',
    '--app-shadow-raised': '0 4px 12px rgba(0, 0, 0, 0.45), 0 24px 56px -24px rgba(0, 0, 0, 0.85)',
    '--app-scrollbar-thumb': 'rgba(255, 255, 255, 0.16)',
  },
});
