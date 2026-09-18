import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useClipboard } from '@mantine/hooks';
import {
  IconCopy,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconPlugConnected,
  IconPlus,
  IconRouter,
  IconTrash,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { fetchClientsConf, useDeleteNas, useNasList, useNasProbe, useSaveNas } from '../api/hooks';
import type { Nas } from '../api/types';
import { notifyError, notifyOk } from '../lib/notify';

const EMPTY: Nas = {
  id: 0,
  nasname: '',
  shortname: '',
  type: 'other',
  ports: null,
  secret: '',
  server: '',
  community: '',
  description: 'RADIUS Client',
};

function NasEditor({ initial, onClose }: { initial: Nas; onClose: () => void }) {
  const isEdit = initial.id > 0;
  const save = useSaveNas(isEdit ? 'update' : 'create');
  const [form, setForm] = useState<Nas>(initial);

  useEffect(() => setForm(initial), [initial]);

  const set = (patch: Partial<Nas>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    try {
      await save.mutateAsync({ ...form, id: isEdit ? form.id : undefined });
      notifyOk(isEdit ? 'NAS actualizado' : 'NAS creado');
      onClose();
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack>
      <TextInput
        label="IP o hostname (nasname)"
        value={form.nasname}
        onChange={(e) => set({ nasname: e.currentTarget.value })}
        required
      />
      <Group grow>
        <TextInput
          label="Nombre corto"
          value={form.shortname ?? ''}
          onChange={(e) => set({ shortname: e.currentTarget.value })}
        />
        <TextInput
          label="Tipo"
          value={form.type ?? ''}
          onChange={(e) => set({ type: e.currentTarget.value })}
        />
      </Group>
      <TextInput
        label="Secret compartido"
        value={form.secret}
        onChange={(e) => set({ secret: e.currentTarget.value })}
        required
      />
      <TextInput
        label="Descripcion"
        value={form.description ?? ''}
        onChange={(e) => set({ description: e.currentTarget.value })}
      />
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          onClick={submit}
          loading={save.isPending}
          disabled={!form.nasname.trim() || !form.secret.trim()}
        >
          Guardar
        </Button>
      </Group>
    </Stack>
  );
}

function SecretCell({ secret }: { secret: string }) {
  const [shown, setShown] = useState(false);
  const clipboard = useClipboard({ timeout: 1200 });
  return (
    <Group gap={4} wrap="nowrap">
      <Text className="mono">{shown ? secret : '•'.repeat(Math.min(12, secret.length))}</Text>
      <ActionIcon variant="subtle" size="sm" onClick={() => setShown((s) => !s)}>
        {shown ? <IconEyeOff size={14} /> : <IconEye size={14} />}
      </ActionIcon>
      <Tooltip label={clipboard.copied ? 'Copiado' : 'Copiar'}>
        <ActionIcon variant="subtle" size="sm" onClick={() => clipboard.copy(secret)}>
          <IconCopy size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

export function NasPage() {
  const list = useNasList();
  const del = useDeleteNas();
  const probe = useNasProbe();
  const [editing, setEditing] = useState<Nas | null>(null);

  const runProbe = async (nas: Nas) => {
    try {
      const r = await probe.mutateAsync(nas.id);
      if (r.responded) notifyOk(`${nas.nasname}:${r.port} responde`);
      else notifyError(new Error(`sin respuesta en :${r.port}`), nas.nasname);
    } catch (err) {
      notifyError(err);
    }
  };

  const showClientsConf = async (nas: Nas) => {
    try {
      const conf = await fetchClientsConf(nas.id);
      modals.open({
        title: `clients.conf — ${nas.nasname}`,
        children: (
          <Stack>
            <Code block>{conf}</Code>
            <Group justify="flex-end">
              <Button
                variant="light"
                onClick={() => {
                  navigator.clipboard?.writeText(conf);
                  notifyOk('Copiado');
                }}
              >
                Copiar
              </Button>
            </Group>
          </Stack>
        ),
      });
    } catch (err) {
      notifyError(err);
    }
  };

  const confirmDelete = (nas: Nas) =>
    modals.openConfirmModal({
      title: `Borrar NAS ${nas.nasname}`,
      children: <Text size="sm">Los equipos que usen esta IP dejaran de poder autenticar.</Text>,
      labels: { confirm: 'Borrar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await del.mutateAsync(nas.id);
          notifyOk('NAS borrado');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  return (
    <Stack gap="lg">
      <PageHeader
        title="NAS / clientes RADIUS"
        subtitle="Equivale a clients.conf — IP y secret compartido de cada equipo"
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing(EMPTY)}>
            Nuevo NAS
          </Button>
        }
      />

      <SectionCard
        title="Clientes registrados"
        subtitle="Tabla nas"
        bodyPadding={false}
        footer={
          <Text size="sm" c="dimmed">
            {list.data?.length ?? 0} NAS
          </Text>
        }
      >
        <Table.ScrollContainer minWidth={640}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>nasname</Table.Th>
                <Table.Th>Nombre corto</Table.Th>
                <Table.Th>Tipo</Table.Th>
                <Table.Th>Secret</Table.Th>
                <Table.Th>Descripcion</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.isLoading && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <Center h={120}>
                      <Loader />
                    </Center>
                  </Table.Td>
                </Table.Tr>
              )}
              {list.data?.map((nas) => (
                <Table.Tr key={nas.id}>
                  <Table.Td fw={550} className="mono">
                    {nas.nasname}
                  </Table.Td>
                  <Table.Td>{nas.shortname || '—'}</Table.Td>
                  <Table.Td>
                    {nas.type ? (
                      <Badge variant="light" size="sm" color="gray">
                        {nas.type}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </Table.Td>
                  <Table.Td>
                    <SecretCell secret={nas.secret} />
                  </Table.Td>
                  <Table.Td>{nas.description || '—'}</Table.Td>
                  <Table.Td>
                    <Group gap={2} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Probar (CoA)">
                        <ActionIcon
                          variant="subtle"
                          loading={probe.isPending && probe.variables === nas.id}
                          onClick={() => runProbe(nas)}
                        >
                          <IconPlugConnected size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="clients.conf">
                        <ActionIcon variant="subtle" onClick={() => showClientsConf(nas)}>
                          <IconFileText size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Editar">
                        <ActionIcon variant="subtle" onClick={() => setEditing(nas)}>
                          <IconEdit size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Borrar">
                        <ActionIcon variant="subtle" color="red" onClick={() => confirmDelete(nas)}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
              {list.data && !list.data.length && (
                <Table.Tr>
                  <Table.Td colSpan={6}>
                    <EmptyState
                      icon={<IconRouter size={22} />}
                      title="No hay NAS registrados"
                      description="Sin clientes en esta tabla, FreeRADIUS rechazara las peticiones por secret desconocido."
                      action={
                        <Button
                          size="xs"
                          variant="light"
                          leftSection={<IconPlus size={14} />}
                          onClick={() => setEditing(EMPTY)}
                        >
                          Nuevo NAS
                        </Button>
                      }
                    />
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </SectionCard>

      <Modal
        opened={!!editing}
        onClose={() => setEditing(null)}
        title={editing && editing.id > 0 ? `Editar ${editing.nasname}` : 'Nuevo NAS'}
      >
        {editing && <NasEditor initial={editing} onClose={() => setEditing(null)} />}
      </Modal>
    </Stack>
  );
}
