import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Image,
  Loader,
  PasswordInput,
  PinInput,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import {
  IconDeviceMobile,
  IconLogout,
  IconShieldCheck,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import {
  useChangeOwnPassword,
  useConfirmTotp,
  useDisableTotp,
  usePanelSessions,
  useRevokeAllPanelSessions,
  useRevokePanelSession,
  useStartTotpSetup,
} from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import type { TotpEnrollment } from '../api/types';
import { formatDateTime, relativeTime } from '../lib/format';
import { notifyError, notifyOk } from '../lib/notify';

/* ------------------------------ Contrasena ------------------------------ */

function PasswordCard() {
  const change = useChangeOwnPassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');

  const mismatch = repeat.length > 0 && next !== repeat;
  const canSubmit = current.length > 0 && next.length >= 8 && next === repeat;

  const submit = async () => {
    try {
      await change.mutateAsync({ currentPassword: current, newPassword: next });
      notifyOk('Contrasena cambiada. Se han cerrado tus otras sesiones.');
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <SectionCard
      title="Contrasena"
      subtitle="Al cambiarla se cierran el resto de sesiones abiertas"
    >
      <Stack gap="sm">
        <PasswordInput
          label="Contrasena actual"
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
          autoComplete="current-password"
        />
        <PasswordInput
          label="Nueva contrasena"
          description="Minimo 8 caracteres"
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          autoComplete="new-password"
        />
        <PasswordInput
          label="Repite la nueva contrasena"
          value={repeat}
          onChange={(e) => setRepeat(e.currentTarget.value)}
          error={mismatch ? 'No coinciden' : undefined}
          autoComplete="new-password"
        />
        <Group justify="flex-end">
          <Button onClick={submit} loading={change.isPending} disabled={!canSubmit}>
            Cambiar contrasena
          </Button>
        </Group>
      </Stack>
    </SectionCard>
  );
}

/* --------------------------------- 2FA ---------------------------------- */

function TotpCard() {
  const { user, refreshUser } = useAuth();
  const setup = useStartTotpSetup();
  const confirm = useConfirmTotp();
  const disable = useDisableTotp();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');

  const enabled = user?.totpEnabled === true;

  const start = async () => {
    try {
      setEnrollment(await setup.mutateAsync());
      setCode('');
    } catch (err) {
      notifyError(err);
    }
  };

  const finish = async (value: string) => {
    try {
      await confirm.mutateAsync(value);
      await refreshUser();
      setEnrollment(null);
      notifyOk('Verificacion en dos pasos activada');
    } catch (err) {
      notifyError(err);
      setCode('');
    }
  };

  const askDisable = () =>
    modals.open({
      title: 'Desactivar verificacion en dos pasos',
      children: <DisableTotpForm onDone={refreshUser} disableFn={disable.mutateAsync} />,
    });

  return (
    <SectionCard
      title="Verificacion en dos pasos"
      subtitle="Codigo temporal de una app como Google Authenticator o Aegis"
      actions={
        <Badge
          variant="light"
          color={enabled ? 'teal' : 'gray'}
          leftSection={enabled ? <IconShieldCheck size={12} /> : <IconShieldOff size={12} />}
        >
          {enabled ? 'activa' : 'desactivada'}
        </Badge>
      }
    >
      {enabled ? (
        <Stack gap="sm">
          <Alert variant="light" color="teal" icon={<IconShieldCheck size={17} />}>
            Tu cuenta pide un codigo de 6 digitos cada vez que inicias sesion.
          </Alert>
          <Group justify="flex-end">
            <Button color="red" variant="light" onClick={askDisable}>
              Desactivar
            </Button>
          </Group>
        </Stack>
      ) : enrollment ? (
        <Stack gap="md" align="center">
          <Text size="sm" c="dimmed" ta="center">
            Escanea el codigo con tu aplicacion y despues introduce el numero que te muestre.
          </Text>
          <Image src={enrollment.qrDataUrl} w={200} h={200} alt="Codigo QR para el 2FA" />
          <Stack gap={4} align="center">
            <Text size="xs" c="dimmed">
              Si no puedes escanear, introduce esta clave a mano:
            </Text>
            <Code>{enrollment.secret}</Code>
          </Stack>
          <PinInput
            length={6}
            type="number"
            oneTimeCode
            value={code}
            onChange={setCode}
            onComplete={finish}
            disabled={confirm.isPending}
            aria-label="Codigo de verificacion"
          />
          <Group>
            <Button variant="default" onClick={() => setEnrollment(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => finish(code)}
              loading={confirm.isPending}
              disabled={code.length < 6}
            >
              Activar
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" size={38} radius="md">
              <IconDeviceMobile size={20} />
            </ThemeIcon>
            <Text size="sm" c="dimmed">
              Anade un segundo factor para que una contrasena robada no baste para entrar.
            </Text>
          </Group>
          <Group justify="flex-end">
            <Button onClick={start} loading={setup.isPending}>
              Activar 2FA
            </Button>
          </Group>
        </Stack>
      )}
    </SectionCard>
  );
}

function DisableTotpForm({
  onDone,
  disableFn,
}: {
  onDone: () => Promise<void>;
  disableFn: (password: string) => Promise<unknown>;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Confirma con tu contrasena para desactivar el segundo factor.
      </Text>
      <PasswordInput
        label="Contrasena"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        autoFocus
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={() => modals.closeAll()}>
          Cancelar
        </Button>
        <Button
          color="red"
          loading={busy}
          disabled={!password}
          onClick={async () => {
            setBusy(true);
            try {
              await disableFn(password);
              await onDone();
              notifyOk('Verificacion en dos pasos desactivada');
              modals.closeAll();
            } catch (err) {
              notifyError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Desactivar
        </Button>
      </Group>
    </Stack>
  );
}

/* ------------------------------- Sesiones -------------------------------- */

function SessionsCard() {
  const sessions = usePanelSessions();
  const revoke = useRevokePanelSession();
  const revokeAll = useRevokeAllPanelSessions();

  const confirmRevokeAll = () =>
    modals.openConfirmModal({
      title: 'Cerrar todas las sesiones',
      children: (
        <Text size="sm">
          Se cerraran todas las sesiones del panel, incluida esta. Tendras que volver a entrar.
        </Text>
      ),
      labels: { confirm: 'Cerrar todas', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const r = await revokeAll.mutateAsync();
          notifyOk(`${r.revoked} sesion(es) cerradas`);
        } catch (err) {
          notifyError(err);
        }
      },
    });

  return (
    <SectionCard
      title="Sesiones abiertas"
      subtitle="Cada navegador donde has iniciado sesion"
      actions={
        <Button
          size="xs"
          variant="light"
          color="red"
          leftSection={<IconLogout size={14} />}
          onClick={confirmRevokeAll}
          disabled={!sessions.data?.length}
        >
          Cerrar todas
        </Button>
      }
      bodyPadding={false}
    >
      <Table.ScrollContainer minWidth={640}>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Inicio</Table.Th>
              <Table.Th>Ultimo uso</Table.Th>
              <Table.Th>IP</Table.Th>
              <Table.Th>Navegador</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sessions.isLoading && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Group justify="center" py="lg">
                    <Loader />
                  </Group>
                </Table.Td>
              </Table.Tr>
            )}
            {sessions.data?.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.created_at)}</Table.Td>
                <Table.Td>{s.last_used_at ? relativeTime(s.last_used_at) : '—'}</Table.Td>
                <Table.Td className="mono">{s.ip || '—'}</Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" lineClamp={1} maw={280}>
                    {s.user_agent || '—'}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group justify="flex-end">
                    <Tooltip label="Revocar esta sesion">
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={async () => {
                          try {
                            await revoke.mutateAsync(s.id);
                            notifyOk('Sesion revocada');
                          } catch (err) {
                            notifyError(err);
                          }
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
            {sessions.data && !sessions.data.length && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <EmptyState
                    icon={<IconLogout size={22} />}
                    title="Sin sesiones registradas"
                    description="Apareceran aqui en cuanto vuelvas a iniciar sesion."
                  />
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </SectionCard>
  );
}

/* -------------------------------- Pagina --------------------------------- */

export function AccountPage() {
  const { user } = useAuth();

  return (
    <Stack gap="lg">
      <PageHeader title="Mi cuenta" subtitle={`Seguridad de la cuenta ${user?.username ?? ''}`} />
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
        <PasswordCard />
        <TotpCard />
      </SimpleGrid>
      <SessionsCard />
    </Stack>
  );
}
