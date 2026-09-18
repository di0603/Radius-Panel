import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconCopy, IconEdit, IconPlus, IconTrash, IconUsersGroup } from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { EmptyState } from '../components/EmptyState';
import { TableSkeleton } from '../components/TableSkeleton';
import { useDeleteGroup, useGroup, useGroups, useSaveGroup } from '../api/hooks';
import type { AttrRow } from '../api/types';
import { AttributeEditor } from '../components/AttributeEditor';
import { notifyError, notifyOk } from '../lib/notify';

interface EditorState {
  mode: 'create' | 'edit';
  groupname: string;
  /** si mode='create' y se indica, se copian los atributos de este grupo */
  cloneFrom?: string;
}

function GroupEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const isEdit = state.mode === 'edit';
  const sourceName = isEdit ? state.groupname : (state.cloneFrom ?? null);
  const detail = useGroup(sourceName);
  const save = useSaveGroup(isEdit ? 'update' : 'create');

  const [groupname, setGroupname] = useState(isEdit ? state.groupname : '');
  const [checks, setChecks] = useState<AttrRow[]>([]);
  const [replies, setReplies] = useState<AttrRow[]>([]);
  const [loaded, setLoaded] = useState(!sourceName);

  useEffect(() => {
    if (sourceName && detail.data && !loaded) {
      if (isEdit) setGroupname(detail.data.groupname);
      setChecks(detail.data.checks);
      setReplies(detail.data.replies);
      setLoaded(true);
    }
  }, [sourceName, isEdit, detail.data, loaded]);

  const submit = async () => {
    try {
      await save.mutateAsync({ groupname: groupname.trim(), checks, replies });
      notifyOk(isEdit ? 'Grupo actualizado' : 'Grupo creado');
      onClose();
    } catch (err) {
      notifyError(err);
    }
  };

  if (sourceName && !loaded) {
    return (
      <Center h={160}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack>
      <TextInput
        label="Nombre del grupo"
        value={groupname}
        onChange={(e) => setGroupname(e.currentTarget.value)}
        disabled={isEdit}
        required
      />
      <Tabs defaultValue="reply">
        <Tabs.List>
          <Tabs.Tab value="reply">Atributos de reply (perfil)</Tabs.Tab>
          <Tabs.Tab value="check">Atributos de check</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="reply" pt="sm">
          <AttributeEditor kind="reply" rows={replies} onChange={setReplies} />
        </Tabs.Panel>
        <Tabs.Panel value="check" pt="sm">
          <AttributeEditor kind="check" rows={checks} onChange={setChecks} />
        </Tabs.Panel>
      </Tabs>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={submit} loading={save.isPending} disabled={!groupname.trim()}>
          Guardar
        </Button>
      </Group>
    </Stack>
  );
}

export function GroupsPage() {
  const list = useGroups();
  const del = useDeleteGroup();
  const [editor, setEditor] = useState<EditorState | null>(null);

  const confirmDelete = (groupname: string, memberCount: number) =>
    modals.openConfirmModal({
      title: `Borrar grupo ${groupname}`,
      children: (
        <Text size="sm">
          {memberCount > 0
            ? `Este grupo tiene ${memberCount} usuario(s). Se quitara la pertenencia a todos ellos.`
            : 'Se eliminaran sus atributos de check y reply.'}
        </Text>
      ),
      labels: { confirm: 'Borrar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await del.mutateAsync({ name: groupname, force: memberCount > 0 });
          notifyOk('Grupo borrado');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  return (
    <Stack gap="lg">
      <PageHeader
        title="Grupos y perfiles"
        subtitle="Atributos aplicados a todos los usuarios del grupo"
        actions={
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setEditor({ mode: 'create', groupname: '' })}
          >
            Nuevo grupo
          </Button>
        }
      />

      <SectionCard
        title="Grupos"
        subtitle="radgroupcheck / radgroupreply"
        bodyPadding={false}
        footer={
          <Text size="sm" c="dimmed">
            {list.data?.length ?? 0} grupo(s)
          </Text>
        }
      >
        <Table.ScrollContainer minWidth={560}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Grupo</Table.Th>
                <Table.Th ta="right">Check</Table.Th>
                <Table.Th ta="right">Reply</Table.Th>
                <Table.Th ta="right">Usuarios</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.isLoading && <TableSkeleton rows={5} cols={5} />}
              {list.data?.map((g) => (
                <Table.Tr key={g.groupname}>
                  <Table.Td fw={550}>{g.groupname}</Table.Td>
                  <Table.Td ta="right">{g.checkCount}</Table.Td>
                  <Table.Td ta="right">{g.replyCount}</Table.Td>
                  <Table.Td ta="right">
                    <Badge variant="light" size="sm">
                      {g.memberCount}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Editar">
                        <ActionIcon
                          variant="subtle"
                          onClick={() => setEditor({ mode: 'edit', groupname: g.groupname })}
                        >
                          <IconEdit size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Clonar">
                        <ActionIcon
                          variant="subtle"
                          onClick={() =>
                            setEditor({ mode: 'create', groupname: '', cloneFrom: g.groupname })
                          }
                        >
                          <IconCopy size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Borrar">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => confirmDelete(g.groupname, g.memberCount)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
              {list.data && !list.data.length && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <EmptyState
                      icon={<IconUsersGroup size={22} />}
                      title="Aun no hay grupos"
                      description="Los grupos aplican atributos comunes a varios usuarios: velocidad, pool de IP, timeouts."
                      action={
                        <Button
                          size="xs"
                          variant="light"
                          leftSection={<IconPlus size={14} />}
                          onClick={() => setEditor({ mode: 'create', groupname: '' })}
                        >
                          Nuevo grupo
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
        opened={!!editor}
        onClose={() => setEditor(null)}
        title={editor?.mode === 'edit' ? `Editar ${editor.groupname}` : 'Nuevo grupo'}
        size="lg"
      >
        {editor && <GroupEditor state={editor} onClose={() => setEditor(null)} />}
      </Modal>
    </Stack>
  );
}
