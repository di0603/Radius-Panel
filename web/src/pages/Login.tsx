import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Group,
  PasswordInput,
  PinInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconLock,
  IconRadar2,
  IconShieldLock,
  IconUser,
} from '@tabler/icons-react';
import { GoogleLogin, type CredentialResponse } from '@react-oauth/google';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import { useMeta } from '../api/hooks';

const GOOGLE_READY = !!import.meta.env.VITE_GOOGLE_CLIENT_ID;

export function LoginPage() {
  const { user, login, loginWith2fa, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };
  const meta = useMeta();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const showGoogle = GOOGLE_READY && meta.data?.googleEnabled === true;

  useEffect(() => {
    document.title = 'Acceder · Radius Panel';
  }, []);

  if (user) return <Navigate to={location.state?.from?.pathname ?? '/'} replace />;

  const goHome = () => navigate(location.state?.from?.pathname ?? '/', { replace: true });

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(username, password);
      if (result.status === '2fa') {
        setTicket(result.ticket);
        setPassword('');
      } else {
        goHome();
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      await loginWith2fa(ticket, value);
      goHome();
    } catch (err) {
      setError(apiErrorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setTicket(null);
    setCode('');
    setError(null);
  };

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      setError('Google no devolvio credenciales');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await loginWithGoogle(credentialResponse.credential);
      if (result.status === '2fa') setTicket(result.ticket);
      else goHome();
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
              {ticket ? (
                <IconShieldLock size={26} stroke={1.7} />
              ) : (
                <IconRadar2 size={26} stroke={1.7} />
              )}
            </div>
            <Title order={3} ta="center" style={{ letterSpacing: '-0.02em' }}>
              {ticket ? 'Verificacion en dos pasos' : 'Radius Panel'}
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              {ticket
                ? 'Introduce el codigo de 6 digitos de tu aplicacion de autenticacion'
                : 'Accede con tu cuenta de administrador'}
            </Text>
          </Stack>

          <Divider />

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

          {ticket ? (
            <Stack gap="lg" align="center">
              <PinInput
                length={6}
                type="number"
                oneTimeCode
                autoFocus
                size="md"
                value={code}
                onChange={setCode}
                onComplete={submitCode}
                disabled={busy}
                aria-label="Codigo de verificacion"
              />
              <Group justify="space-between" w="100%">
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={<IconArrowLeft size={14} />}
                  onClick={restart}
                  disabled={busy}
                >
                  Volver
                </Button>
                <Button
                  size="sm"
                  loading={busy}
                  disabled={code.length < 6}
                  onClick={() => submitCode(code)}
                >
                  Verificar
                </Button>
              </Group>
            </Stack>
          ) : (
            <Stack gap="md">
              {showGoogle && (
                <>
                  <Group justify="center">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={() => setError('No se pudo iniciar sesion con Google')}
                      theme="outline"
                      size="large"
                      shape="rectangular"
                      text="signin_with"
                      width={340}
                    />
                  </Group>
                  <Divider label="o con tu cuenta local" labelPosition="center" />
                </>
              )}
              <form onSubmit={submitCredentials}>
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
          )}
        </Stack>
      </Card>
    </div>
  );
}
