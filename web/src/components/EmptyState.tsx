import { Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';

interface Props {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/** Estado vacio con icono, mensaje y accion opcional. Sirve dentro de una celda de tabla. */
export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <Stack align="center" gap={8} py={40} px="md">
      <ThemeIcon variant="light" color="gray" size={46} radius="xl">
        {icon}
      </ThemeIcon>
      <Text fw={600} size="sm">
        {title}
      </Text>
      {description && (
        <Text size="xs" c="dimmed" ta="center" maw={340}>
          {description}
        </Text>
      )}
      {action}
    </Stack>
  );
}
