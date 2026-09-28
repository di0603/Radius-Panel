import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  Center,
  Modal,
  MultiSelect,
  Pagination,
  PasswordInput,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useDebouncedValue } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconDownload,
  IconEdit,
  IconPlayerPlay,
  IconPlugConnectedX,
  IconPlus,
  IconEye,
  IconSearch,
  IconTrash,
  IconUpload,
  IconUsers,
} from '@tabler/icons-react';
import { PageHeader } from '../components/PageHeader';
import { SectionCard } from '../components/SectionCard';
import { UserDrawer } from '../components/UserDrawer';
import { EmptyState } from '../components/EmptyState';
import { TableSkeleton } from '../components/TableSkeleton';
import { AttributeEditor } from '../components/AttributeEditor';
import {
  useBulkCreateUsers,
  useDeleteUser,
  useDisconnectUserSessions,
  useGroups,
  useMeta,
  useSaveUser,
  useSetUserEnabled,
  useTestUser,
  useUser,
  useUsers,
  useVpnDevices,
  type TestAuthResult,
} from '../api/hooks';
import type { AttrRow, UserWriteInput } from '../api/types';
import { downloadCsv } from '../lib/csv';
import { useUrlState } from '../lib/useUrlState';
import { notifyError, notifyOk } from '../lib/notify';

const PAGE = 25;
const PASSWORD_ATTRS = ['Cleartext-Password', 'NT-Password'];
const EXP_FMT = 'DD MMM YYYY';

interface EditorState {
  mode: 'create' | 'edit';
  username: string;
}

/* ------------------------------ Editor ---------------------------- */

function UserEditor({ state, onClose }: { state: EditorState; onClose: () => void }) {
  const isEdit = state.mode === 'edit';
  const detail = useUser(isEdit ? state.username : null);
  const groups = useGroups();
  const save = useSaveUser(isEdit ? 'update' : 'create');
  const navigate = useNavigate();
  const vpnDevices = useVpnDevices();
  const isVpnDevice = isEdit && vpnDevices.data?.some((d) => d.username === state.username);

  const [username, setUsername] = useState(state.username);
  const [password, setPassword] = useState('');
  const [passwordType, setPasswordType] = useState<'cleartext' | 'nt'>('cleartext');
  const [checks, setChecks] = useState<AttrRow[]>([]);
  const [replies, setReplies] = useState<AttrRow[]>([]);
  const [memberOf, setMemberOf] = useState<string[]>([]);
  const [expiration, setExpiration] = useState<Date | null>(null);
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [loaded, setLoaded] = useState(!isEdit);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (isEdit && detail.data && !loaded) {
      setUsername(detail.data.username);
      setChecks(
        detail.data.checks.filter(
          (c) => !PASSWORD_ATTRS.includes(c.attribute) && c.attribute !== 'Expiration',
        ),
      );
      setReplies(detail.data.replies);
      setMemberOf(detail.data.groups.map((g) => g.groupname));
      setEmail(detail.data.email ?? '');
      setNotes(detail.data.notes ?? '');
      setPasswordType(
        detail.data.checks.some((c) => c.attribute === 'NT-Password') ? 'nt' : 'cleartext',
      );
      const exp = detail.data.checks.find((c) => c.attribute === 'Expiration');
      if (exp) {
        const d = dayjs(exp.value, EXP_FMT);
        setExpiration(d.isValid() ? d.toDate() : null);
      }
      setLoaded(true);
    }
  }, [isEdit, detail.data, loaded]);

  const touched =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setDirty(true);
      setter(v);
    };

  const submit = async () => {
    const finalChecks = [...checks];
    if (expiration) {
      finalChecks.push({
        attribute: 'Expiration',
        op: ':=',
        value: dayjs(expiration).format(EXP_FMT),
      });
    }
    const input: UserWriteInput = {
      username: username.trim(),
      password: password || null,
      passwordType,
      checks: finalChecks,
      replies,
      groups: memberOf.map((groupname, i) => ({ groupname, priority: i + 1 })),
      email: email.trim() || null,
      notes: notes.trim() || null,
    };
    try {
      const res = await save.mutateAsync(input);
      const warnings = (res as unknown as { warnings?: { message: string }[] }).warnings ?? [];
      notifyOk(isEdit ? 'Usuario actualizado' : 'Usuario creado');
      if (warnings.length) {
        notifyOk(`${warnings.length} aviso(s) sobre atributos no reconocidos`);
      }
      setDirty(false);
      onClose();
    } catch (err) {
      notifyError(err);
    }
  };

  const tryClose = () => {
    if (!dirty) return onClose();
    modals.openConfirmModal({
      title: 'Descartar cambios',
      children: <Text size="sm">Hay cambios sin guardar. ¿Salir igualmente?</Text>,
      labels: { confirm: 'Salir', cancel: 'Seguir editando' },
      confirmProps: { color: 'red' },
      onConfirm: onClose,
    });
  };

  if (isEdit && !loaded) {
    return (
      <Center h={160}>
        <Loader />
      </Center>
    );
  }

  return (
    <Stack>
      {isVpnDevice && (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={16} />}
          title="Este usuario es un dispositivo VPN"
        >
          Se gestiona desde VPN › Dispositivos: la IP fija, el grupo <b>vpn</b> y su certificado se
          pueden romper si lo editas aqui a mano.{' '}
          <Text
            span
            fw={600}
            style={{ cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => {
              modals.closeAll();
              navigate(`/vpn-devices?open=${encodeURIComponent(state.username)}`);
            }}
          >
            Ir a su ficha
          </Text>
        </Alert>
      )}
      <Group grow align="flex-end">
        <TextInput
          label="Usuario"
          value={username}
          onChange={(e) => touched(setUsername)(e.currentTarget.value)}
          disabled={isEdit}
          required
        />
        <SegmentedControl
          value={passwordType}
          onChange={(v) => touched(setPasswordType)(v as 'cleartext' | 'nt')}
          data={[
            { label: 'Cleartext', value: 'cleartext' },
            { label: 'NT-Password', value: 'nt' },
          ]}
        />
      </Group>
      <PasswordInput
        label={isEdit ? 'Nueva contrasena (vacio = no cambiar)' : 'Contrasena'}
        value={password}
        onChange={(e) => touched(setPassword)(e.currentTarget.value)}
        required={!isEdit}
      />

      <Group grow>
        <MultiSelect
          label="Grupos"
          placeholder="Selecciona grupos"
          data={(groups.data ?? []).map((g) => g.groupname)}
          value={memberOf}
          onChange={touched(setMemberOf)}
          searchable
        />
        <DateInput
          label="Caducidad (Expiration)"
          placeholder="sin caducidad"
          valueFormat={EXP_FMT}
          clearable
          value={expiration}
          onChange={touched(setExpiration)}
        />
      </Group>

      <Group grow align="flex-start">
        <TextInput
          label="Email de contacto"
          description="No va a RADIUS: solo para poder escribirle al usuario"
          type="email"
          placeholder="cliente@ejemplo.com"
          value={email}
          onChange={(e) => touched(setEmail)(e.currentTarget.value)}
        />
        <Textarea
          label="Notas"
          placeholder="Direccion, telefono, plan contratado..."
          autosize
          minRows={1}
          maxRows={4}
          value={notes}
          onChange={(e) => touched(setNotes)(e.currentTarget.value)}
        />
      </Group>

      <Tabs defaultValue="check">
        <Tabs.List>
          <Tabs.Tab value="check">Atributos de check</Tabs.Tab>
          <Tabs.Tab value="reply">Atributos de reply</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="check" pt="sm">
          <AttributeEditor kind="check" rows={checks} onChange={touched(setChecks)} />
        </Tabs.Panel>
        <Tabs.Panel value="reply" pt="sm">
          <AttributeEditor kind="reply" rows={replies} onChange={touched(setReplies)} />
        </Tabs.Panel>
      </Tabs>

      <Group justify="flex-end">
        <Button variant="default" onClick={tryClose}>
          Cancelar
        </Button>
        <Button onClick={submit} loading={save.isPending} disabled={!username.trim()}>
          Guardar
        </Button>
      </Group>
    </Stack>
  );
}

/* ---------------------------- Probar auth ------------------------- */

function TestForm({ username }: { username: string }) {
  const test = useTestUser();
  const meta = useMeta();
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<TestAuthResult | null>(null);

  const run = async () => {
    try {
      setResult(await test.mutateAsync({ username, password }));
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack>
      {!meta.data?.testAuthEnabled && (
        <Text size="xs" c="dimmed">
          Prueba deshabilitada en el servidor (RADIUS_TEST_ENABLED=false).
        </Text>
      )}
      <PasswordInput
        label={`Contrasena para "${username}"`}
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        autoFocus
      />
      <Group>
        <Button
          onClick={run}
          loading={test.isPending}
          disabled={!password || !meta.data?.testAuthEnabled}
        >
          Lanzar Access-Request
        </Button>
      </Group>
      {result && (
        <Stack gap="xs">
          <Group>
            <Badge color={result.accepted ? 'teal' : 'red'} size="lg">
              {result.codeName}
            </Badge>
            {result.replyMessage && <Text size="sm">{result.replyMessage}</Text>}
          </Group>
          {!!result.attributes.length && (
            <Code block>
              {result.attributes.map((a) => `attr ${a.type}: ${a.text}`).join('\n')}
            </Code>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/* --------------------------- Importar CSV ------------------------- */

function BulkImportForm({ onDone }: { onDone: () => void }) {
  const bulk = useBulkCreateUsers();
  const [raw, setRaw] = useState('');
  const [report, setReport] = useState<{
    created: string[];
    skipped: { username: string; reason: string }[];
  } | null>(null);

  const rows = useMemo(() => {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [username, password, group] = l.split(/[;,]/).map((s) => s.trim());
        return { username, password: password ?? '', groups: group ? [group] : [] };
      })
      .filter((r) => r.username);
  }, [raw]);

  const run = async () => {
    try {
      setReport(await bulk.mutateAsync(rows));
    } catch (err) {
      notifyError(err);
    }
  };

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Una línea por usuario: <Code>usuario;contraseña;grupo</Code> (el grupo es opcional).
      </Text>
      <Textarea
        autosize
        minRows={6}
        maxRows={14}
        placeholder={'ana;secreta;plan-50m\nluis;otraclave'}
        value={raw}
        onChange={(e) => setRaw(e.currentTarget.value)}
      />
      <Group justify="space-between">
        <Text size="sm">{rows.length} fila(s) detectada(s)</Text>
        <Button onClick={run} loading={bulk.isPending} disabled={!rows.length}>
          Importar
        </Button>
      </Group>
      {report && (
        <Stack gap="xs">
          <Text size="sm" c="teal">
            {report.created.length} creados
          </Text>
          {!!report.skipped.length && (
            <Code block>{report.skipped.map((s) => `${s.username}: ${s.reason}`).join('\n')}</Code>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onDone}>
              Cerrar
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

/* ------------------------------ Página ---------------------------- */

export function UsersPage() {
  const [search, setSearch] = useUrlState('q');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [testUser, setTestUser] = useState<string | null>(null);
  const [detailUser, setDetailUser] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const list = useUsers({ search: debouncedSearch, limit: PAGE, offset: (page - 1) * PAGE });
  const del = useDeleteUser();
  const setEnabled = useSetUserEnabled();
  const disconnectUser = useDisconnectUserSessions();
  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / PAGE));

  const confirmDelete = (username: string) =>
    modals.openConfirmModal({
      title: 'Borrar usuario',
      children: (
        <Text size="sm">
          Se eliminaran todas las filas de radcheck/radreply/radusergroup de <b>{username}</b>. El
          historial de accounting se conserva.
        </Text>
      ),
      labels: { confirm: 'Borrar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await del.mutateAsync(username);
          notifyOk('Usuario borrado');
        } catch (err) {
          notifyError(err);
        }
      },
    });

  const confirmDisconnect = (username: string) =>
    modals.openConfirmModal({
      title: `Desconectar sesiones de ${username}`,
      children: <Text size="sm">Se enviará un Disconnect-Request por cada sesión activa.</Text>,
      labels: { confirm: 'Desconectar', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const r = await disconnectUser.mutateAsync(username);
          notifyOk(`${r.total} sesión(es) procesadas`);
        } catch (err) {
          notifyError(err);
        }
      },
    });

  const pageUsers = list.data?.items ?? [];
  const allSelected = pageUsers.length > 0 && selected.length === pageUsers.length;
  const someSelected = selected.length > 0 && !allSelected;

  const toggleAll = () => setSelected(allSelected ? [] : pageUsers.map((u) => u.username));

  const toggleOne = (username: string) =>
    setSelected((prev) =>
      prev.includes(username) ? prev.filter((u) => u !== username) : [...prev, username],
    );

  /** Aplica una accion a todos los seleccionados y resume el resultado. */
  const runBulk = async (action: (username: string) => Promise<unknown>, verb: string) => {
    const results = await Promise.allSettled(selected.map(action));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (ok) notifyOk(`${ok} usuario(s) ${verb}`);
    if (failed) notifyError(new Error(`${failed} fallaron`), 'Accion en bloque');
    setSelected([]);
  };

  const confirmBulkDelete = () =>
    modals.openConfirmModal({
      title: `Borrar ${selected.length} usuario(s)`,
      children: (
        <Text size="sm">
          Se eliminaran de radcheck, radreply y radusergroup. El accounting se conserva.
        </Text>
      ),
      labels: { confirm: 'Borrar todos', cancel: 'Cancelar' },
      confirmProps: { color: 'red' },
      onConfirm: () => runBulk((u) => del.mutateAsync(u), 'borrados'),
    });

  const exportCsv = () => {
    const items = list.data?.items ?? [];
    downloadCsv(
      `usuarios-${dayjs().format('YYYYMMDD')}`,
      items.map((u) => ({
        usuario: u.username,
        activo: u.disabled ? 'no' : 'si',
        password: u.passwordType ?? (u.hasPassword ? 'set' : ''),
        grupos: u.groups.join('|'),
        reply_attrs: u.replyCount,
        email: u.email ?? '',
      })),
    );
  };

  return (
    <Stack gap="lg">
      <PageHeader
        title="Usuarios"
        subtitle={`${list.data?.total ?? 0} usuarios RADIUS`}
        actions={
          <>
            <Button
              variant="default"
              leftSection={<IconUpload size={16} />}
              onClick={() => setBulkOpen(true)}
            >
              Importar CSV
            </Button>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              onClick={exportCsv}
              disabled={!list.data?.items.length}
            >
              Exportar
            </Button>
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => setEditor({ mode: 'create', username: '' })}
            >
              Nuevo usuario
            </Button>
          </>
        }
      />

      <SectionCard
        title="Listado"
        subtitle="Cuentas de radcheck / radreply"
        actions={
          selected.length ? (
            <Group gap="xs" wrap="wrap">
              <Text size="sm" fw={600}>
                {selected.length} seleccionado(s)
              </Text>
              <Button
                size="xs"
                variant="light"
                onClick={() =>
                  runBulk(
                    (u) => setEnabled.mutateAsync({ username: u, enabled: true }),
                    'activados',
                  )
                }
              >
                Activar
              </Button>
              <Button
                size="xs"
                variant="light"
                color="orange"
                onClick={() =>
                  runBulk(
                    (u) => setEnabled.mutateAsync({ username: u, enabled: false }),
                    'desactivados',
                  )
                }
              >
                Desactivar
              </Button>
              <Button size="xs" variant="light" color="red" onClick={confirmBulkDelete}>
                Borrar
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setSelected([])}>
                Cancelar
              </Button>
            </Group>
          ) : (
            <TextInput
              placeholder="Buscar por nombre de usuario"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => {
                setSearch(e.currentTarget.value);
                setPage(1);
              }}
              w={280}
            />
          )
        }
        bodyPadding={false}
        footer={
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              {list.data?.total ?? 0} usuarios
            </Text>
            <Pagination value={page} onChange={setPage} total={totalPages} />
          </Group>
        }
      >
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>
                  <Checkbox
                    aria-label="Seleccionar todos"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={toggleAll}
                  />
                </Table.Th>
                <Table.Th>Usuario</Table.Th>
                <Table.Th>Activo</Table.Th>
                <Table.Th>Contrasena</Table.Th>
                <Table.Th>Grupos</Table.Th>
                <Table.Th>Email</Table.Th>
                <Table.Th ta="right">Reply attrs</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.isLoading && <TableSkeleton rows={8} cols={8} />}
              {list.data?.items.map((u) => (
                <Table.Tr
                  key={u.username}
                  style={{ opacity: u.disabled ? 0.55 : 1 }}
                  bg={selected.includes(u.username) ? 'var(--app-hover)' : undefined}
                >
                  <Table.Td>
                    <Checkbox
                      aria-label={`Seleccionar ${u.username}`}
                      checked={selected.includes(u.username)}
                      onChange={() => toggleOne(u.username)}
                    />
                  </Table.Td>
                  <Table.Td
                    fw={550}
                    className="row-clickable"
                    onClick={() => setDetailUser(u.username)}
                  >
                    {u.username}
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      size="sm"
                      checked={!u.disabled}
                      onChange={async (e) => {
                        try {
                          await setEnabled.mutateAsync({
                            username: u.username,
                            enabled: e.currentTarget.checked,
                          });
                          notifyOk(
                            e.currentTarget.checked ? 'Usuario activado' : 'Usuario desactivado',
                          );
                        } catch (err) {
                          notifyError(err);
                        }
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    {u.hasPassword ? (
                      <Badge variant="light" size="sm">
                        {u.passwordType ?? 'set'}
                      </Badge>
                    ) : (
                      <Badge variant="light" color="gray" size="sm">
                        sin
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {u.groups.map((g) => (
                        <Badge key={g} variant="dot" size="sm">
                          {g}
                        </Badge>
                      ))}
                      {!u.groups.length && (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {u.email ? (
                      <Text size="sm" lineClamp={1} maw={180}>
                        {u.email}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        —
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">{u.replyCount}</Table.Td>
                  <Table.Td>
                    <Group gap={2} justify="flex-end" wrap="nowrap">
                      <Tooltip label="Ver ficha">
                        <ActionIcon variant="subtle" onClick={() => setDetailUser(u.username)}>
                          <IconEye size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Probar autenticacion">
                        <ActionIcon variant="subtle" onClick={() => setTestUser(u.username)}>
                          <IconPlayerPlay size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Editar">
                        <ActionIcon
                          variant="subtle"
                          onClick={() => setEditor({ mode: 'edit', username: u.username })}
                        >
                          <IconEdit size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Desconectar sesiones">
                        <ActionIcon
                          variant="subtle"
                          color="orange"
                          onClick={() => confirmDisconnect(u.username)}
                        >
                          <IconPlugConnectedX size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Borrar">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => confirmDelete(u.username)}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
              {list.data && !list.data.items.length && (
                <Table.Tr>
                  <Table.Td colSpan={8}>
                    <EmptyState
                      icon={<IconUsers size={22} />}
                      title={search ? 'Sin resultados' : 'Aun no hay usuarios'}
                      description={
                        search
                          ? `Ningun usuario coincide con "${search}".`
                          : 'Crea el primero o importa una lista en CSV.'
                      }
                      action={
                        !search ? (
                          <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconPlus size={14} />}
                            onClick={() => setEditor({ mode: 'create', username: '' })}
                          >
                            Nuevo usuario
                          </Button>
                        ) : undefined
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
        title={editor?.mode === 'edit' ? `Editar ${editor.username}` : 'Nuevo usuario'}
        size="lg"
        closeOnClickOutside={false}
      >
        {editor && <UserEditor state={editor} onClose={() => setEditor(null)} />}
      </Modal>

      <Modal opened={!!testUser} onClose={() => setTestUser(null)} title="Probar autenticacion">
        {testUser && <TestForm username={testUser} />}
      </Modal>

      <UserDrawer
        username={detailUser}
        onClose={() => setDetailUser(null)}
        onEdit={(username) => {
          setDetailUser(null);
          setEditor({ mode: 'edit', username });
        }}
      />

      <Modal
        opened={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Importar usuarios"
        size="lg"
      >
        <BulkImportForm onDone={() => setBulkOpen(false)} />
      </Modal>
    </Stack>
  );
}
