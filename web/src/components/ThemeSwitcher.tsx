import {
  ActionIcon,
  Center,
  ColorSwatch,
  Group,
  Menu,
  SegmentedControl,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { IconCheck, IconDeviceDesktop, IconMoon, IconPalette, IconSun } from '@tabler/icons-react';
import { ACCENTS } from '../theme';
import { useAccent } from './PanelThemeProvider';

const SCHEMES = [
  { value: 'light', label: 'Claro', icon: IconSun },
  { value: 'dark', label: 'Oscuro', icon: IconMoon },
  { value: 'auto', label: 'Sistema', icon: IconDeviceDesktop },
];

export function ThemeSwitcher() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { accent, setAccent } = useAccent();

  return (
    <Menu shadow="md" width={264} position="bottom-end" withinPortal closeOnItemClick={false}>
      <Menu.Target>
        <Tooltip label="Tema y apariencia">
          <ActionIcon variant="default" size="lg" aria-label="Tema y apariencia">
            <IconPalette size={18} stroke={1.7} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>

      <Menu.Dropdown p="sm">
        <Text
          size="xs"
          fw={600}
          c="dimmed"
          tt="uppercase"
          mb={8}
          style={{ letterSpacing: '0.05em' }}
        >
          Modo
        </Text>
        <SegmentedControl
          fullWidth
          size="xs"
          value={colorScheme}
          onChange={(v) => setColorScheme(v as 'light' | 'dark' | 'auto')}
          data={SCHEMES.map((s) => ({
            value: s.value,
            label: (
              <Center style={{ gap: 6 }}>
                <s.icon size={14} stroke={1.8} />
                <span>{s.label}</span>
              </Center>
            ),
          }))}
        />

        <Text
          size="xs"
          fw={600}
          c="dimmed"
          tt="uppercase"
          mt="md"
          mb={8}
          style={{ letterSpacing: '0.05em' }}
        >
          Color de acento
        </Text>
        <Group gap={8}>
          {ACCENTS.map((a) => (
            <Tooltip key={a.id} label={a.label} withArrow>
              <ColorSwatch
                component="button"
                type="button"
                color={a.colors[5]}
                size={28}
                radius="md"
                onClick={() => setAccent(a.id)}
                aria-label={`Acento ${a.label}`}
                aria-pressed={accent === a.id}
                style={{ cursor: 'pointer', color: '#fff' }}
              >
                {accent === a.id && <IconCheck size={15} stroke={3} />}
              </ColorSwatch>
            </Tooltip>
          ))}
        </Group>
      </Menu.Dropdown>
    </Menu>
  );
}
