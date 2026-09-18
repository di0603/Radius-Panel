import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconLock, IconRadar2, IconUser } from '@tabler/icons-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Acceder · Radius Panel';
  }, []);

  if (user) return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate(location.state?.from?.pathname ?? '/', { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <Card className="login-card" withBorder p="xl" radius="lg">
        <Stack gap="lg">
          <Stack gap="xs" align="center">
            <div className="brand-mark login-logo">
              <IconRadar2 size={26} stroke={1.7} />
            </div>
            <Title order={3} ta="center" style={{ letterSpacing: '-0.02em' }}>
              Radius Panel
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              Accede con tu cuenta de administrador
            </Text>
          </Stack>

          <Divider />

          <form onSubmit={submit}>
            <Stack gap="md">
              <TextInput
                label="Usuario"
                placeholder="admin"
                leftSection={<IconUser size={16} stroke={1.7} />}
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
                required
                autoFocus
                autoComplete="username"
                size="md"
              />
              <PasswordInput
                label="Contrasena"
                placeholder="Tu contrasena"
                leftSection={<IconLock size={16} stroke={1.7} />}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                required
                autoComplete="current-password"
                size="md"
              />

              {error && (
                <Alert
                  variant="light"
                  color="red"
                  radius="md"
                  icon={<IconAlertTriangle size={17} />}
                  title="No se pudo entrar"
                >
                  {error}
                </Alert>
              )}

              <Button
                type="submit"
                loading={busy}
                fullWidth
                size="md"
                variant="gradient"
                mt={4}
                disabled={!username.trim() || !password}
              >
                Entrar
              </Button>
            </Stack>
          </form>
        </Stack>
      </Card>
    </div>
  );
}
