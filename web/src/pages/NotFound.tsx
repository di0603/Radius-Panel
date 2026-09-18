import { Button, Card, Center, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconArrowLeft, IconLock, IconMapSearch } from '@tabler/icons-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

function Message({
  icon,
  code,
  title,
  description,
  documentTitle,
}: {
  icon: React.ReactNode;
  code: string;
  title: string;
  description: string;
  documentTitle: string;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    document.title = `${documentTitle} · Radius Panel`;
  }, [documentTitle]);

  return (
    <Center mih="60vh">
      <Card withBorder p="xl" maw={460} w="100%">
        <Stack align="center" gap="sm">
          <ThemeIcon variant="light" size={56} radius="xl">
            {icon}
          </ThemeIcon>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.1em' }}>
            Error {code}
          </Text>
          <Title order={3} ta="center">
            {title}
          </Title>
          <Text size="sm" c="dimmed" ta="center">
            {description}
          </Text>
          <Button
            mt="xs"
            variant="light"
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => navigate('/')}
          >
            Volver al panel
          </Button>
        </Stack>
      </Card>
    </Center>
  );
}

export function NotFoundPage() {
  return (
    <Message
      icon={<IconMapSearch size={28} stroke={1.7} />}
      code="404"
      title="Pagina no encontrada"
      description="La direccion que has abierto no existe en el panel. Puede que el enlace sea antiguo."
      documentTitle="No encontrado"
    />
  );
}

export function ForbiddenPage() {
  return (
    <Message
      icon={<IconLock size={28} stroke={1.7} />}
      code="403"
      title="Sin permiso"
      description="Esta seccion esta reservada al rol admin. Pide a un administrador que te cambie el rol si necesitas acceder."
      documentTitle="Sin permiso"
    />
  );
}
