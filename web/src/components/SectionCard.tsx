import { Card, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** `false` cuando el contenido es una tabla que debe llegar a los bordes. */
  bodyPadding?: boolean;
  children: ReactNode;
}

/** Tarjeta con cabecera, cuerpo y pie opcionales. Unifica el aspecto de las paginas. */
export function SectionCard({
  title,
  subtitle,
  actions,
  footer,
  bodyPadding = true,
  children,
}: Props) {
  return (
    <Card className="table-card">
      {(title || actions) && (
        <div className="table-card-header">
          <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <Stack gap={2}>
              {title && (
                <Text fw={650} size="sm">
                  {title}
                </Text>
              )}
              {subtitle && (
                <Text size="xs" c="dimmed">
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
        </div>
      )}

      <div style={bodyPadding ? { padding: 'var(--mantine-spacing-lg)' } : undefined}>
        {children}
      </div>

      {footer && <div className="table-card-footer">{footer}</div>}
    </Card>
  );
}
