import { Group, Stack, Text, Title } from '@mantine/core';
import { useEffect, type ReactNode } from 'react';

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: Props) {
  useEffect(() => {
    document.title = `${title} · Radius Panel`;
  }, [title]);

  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="md" mb="xs">
      <Stack gap={4}>
        <Title order={2} style={{ letterSpacing: '-0.02em' }}>
          {title}
        </Title>
        {subtitle && (
          <Text size="sm" c="dimmed">
            {subtitle}
          </Text>
        )}
      </Stack>
      {actions && (
        <Group gap="xs" wrap="wrap">
          {actions}
        </Group>
      )}
    </Group>
  );
}
