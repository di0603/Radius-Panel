import { useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconKey, IconPlus, IconTrash } from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { useAdmins, useCreateAdmin, useDeleteAdmin, useUpdateAdmin } from '../api/hooks';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../lib/format';
import { notifyError, notifyOk } from '../lib/notify';

function CreateModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const create = useCreateAdmin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'operator'>('operator');

  const submit = async () => {
    try {
      await create.mutateAsync({ username: username.trim(), password, role });
      notifyOk('Administrador creado');
      setUsername('');
      setPassword('');
      onClose();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Nuevo administrador">
      <Stack>
        <TextInput
          label="Usuario"
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          required
        />
        <PasswordInput
          label="Contrasena (min 8)"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />
        <Select
          label="Rol"
          data={[
            { value: 'operator', label: 'operator — gestiona RADIUS' },
            { value: 'admin', label: 'admin — todo, incluye admins y auditoria' },
          ]}
          value={role}
          onChange={(v) => setRole((v as 'admin' | 'operator') ?? 'operator')}
          allowDeselect={false}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            loading={create.isPending}
            disabled={!username.trim() || password.length < 8}
          >
            Crear
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function AdminsPage() {
  const list = useAdmins();
  const update = useUpdateAdmin();
  const del = useDeleteAdmin();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);

  const resetPassword = (id: number, username: string) =>
    modals.open({
      title: `Cambiar contrasena de ${username}`,
      children: <ResetPasswordForm id={id} />,
    });

  const confirmDelete = (id: number, username: string) =>
    modals.openConfirmModal({
      title: `Borrar administrador ${username}`,
      labels: { confirm: 'Borrar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await del.mutateAsync(id);
          notifyOk('Administrador borrado');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  return (
    <Stack gap="lg">
      <PageHeader
        title="Administradores del panel"
        subtitle="Cuentas que acceden a este panel (no son usuarios RADIUS)"
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
            Nuevo administrador
          </Button>
        }
      />

      <SectionCard
        title="Cuentas del panel"
        subtitle="Tabla panel_admins"
        bodyPadding={false}
        footer={
          <Text size="sm" c="dimmed">
            {list.data?.length ?? 0} cuenta(s)
          </Text>
        }
      >
        <Table.ScrollContainer minWidth={640}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Usuario</Table.Th>
                <Table.Th>Rol</Table.Th>
                <Table.Th>Activo</Table.Th>
                <Table.Th>Ultimo acceso</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.isLoading && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Center h={120}>
                      <Loader />
                    </Center>
                  </Table.Td>
                </Table.Tr>
              )}
              {list.data?.map((a) => {
                const isSelf = a.id === (user?.id ?? user?.sub);
                return (
                  <Table.Tr key={a.id}>
                    <Table.Td fw={550}>
                      <Group gap={6} wrap="nowrap">
                        {a.username}
                        {isSelf && (
                          <Badge size="xs" variant="light">
                            tu
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={['operator', 'admin']}
                        value={a.role}
                        disabled={isSelf}
                        allowDeselect={false}
                        onChange={async (v) => {
                          if (!v || v === a.role) return;
                          try {
                            await update.mutateAsync({ id: a.id, role: v as 'admin' | 'operator' });
                            notifyOk('Rol actualizado');
                          } catch (err) {
                            notifyError(err);
                          }
                        }}
                        w={130}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Switch
                        size="sm"
                        checked={a.active}
                        disabled={isSelf}
                        onChange={async (e) => {
                          try {
                            await update.mutateAsync({ id: a.id, active: e.currentTarget.checked });
                            notifyOk('Estado actualizado');
                          } catch (err) {
                            notifyError(err);
                          }
                        }}
                      />
                    </Table.Td>
                    <Table.Td>{formatDateTime(a.last_login_at)}</Table.Td>
                    <Table.Td>
                      <Group gap={2} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Cambiar contrasena">
                          <ActionIcon
                            variant="subtle"
                            onClick={() => resetPassword(a.id, a.username)}
                          >
                            <IconKey size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={isSelf ? 'No puedes borrarte' : 'Borrar'}>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            disabled={isSelf}
                            onClick={() => confirmDelete(a.id, a.username)}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SectionCard>

      <CreateModal opened={createOpen} onClose={() => setCreateOpen(false)} />
    </Stack>
  );
}

function ResetPasswordForm({ id }: { id: number }) {
  const update = useUpdateAdmin();
  const [password, setPassword] = useState('');
  return (
    <Stack>
      <PasswordInput
        label="Nueva contrasena (min 8)"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        autoFocus
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={() => modals.closeAll()}>
          Cancelar
        </Button>
        <Button
          loading={update.isPending}
          disabled={password.length < 8}
          onClick={async () => {
            try {
              await update.mutateAsync({ id, password });
              notifyOk('Contrasena cambiada');
              modals.closeAll();
            } catch (err) {
              notifyError(err);
            }
          }}
        >
          Guardar
        </Button>
      </Group>
    </Stack>
  );
}
