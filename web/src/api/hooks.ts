import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/* ------------------------------- Meta ----------------------------- */

export interface Meta {
  name: string;
  version: string;
  coaEnabled: boolean;
  testAuthEnabled: boolean;
  dbOk: boolean;
}

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => (await api.get<Meta>('/meta')).data,
  });
}

export function useDictionary() {
  return useQuery({
    queryKey: ['dictionary'],
    staleTime: Infinity,
    queryFn: async () =>
      (
        await api.get<{
          attributes: string[];
          defs: Record<string, { type: string; values?: string[]; note?: string }>;
        }>('/meta/dictionary')
      ).data,
  });
}
import type {
  Admin,
  AuditEntry,
  AuthFailure,
  GroupDetail,
  GroupSummary,
  Nas,
  Overview,
  Paged,
  Session,
  TopUser,
  UserDetail,
  UserGroup,
  UserSummary,
  UserWriteInput,
} from './types';

/* ----------------------------- Usuarios ----------------------------- */

export function useUsers(params: { search: string; limit: number; offset: number }) {
  return useQuery({
    queryKey: ['users', params],
    queryFn: async () => (await api.get<Paged<UserSummary>>('/users', { params })).data,
  });
}

export function useUser(username: string | null) {
  return useQuery({
    queryKey: ['user', username],
    enabled: !!username,
    queryFn: async () =>
      (await api.get<UserDetail>(`/users/${encodeURIComponent(username!)}`)).data,
  });
}

export function useSaveUser(mode: 'create' | 'update') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UserWriteInput) => {
      if (mode === 'create') return (await api.post<UserDetail>('/users', input)).data;
      return (await api.put<UserDetail>(`/users/${encodeURIComponent(input.username)}`, input))
        .data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user'] });
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      await api.delete(`/users/${encodeURIComponent(username)}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useSetUserEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, enabled }: { username: string; enabled: boolean }) => {
      await api.patch(`/users/${encodeURIComponent(username)}/enabled`, { enabled });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user'] });
    },
  });
}

export interface TestAuthResult {
  code: number;
  codeName: string;
  accepted: boolean;
  replyMessage?: string;
  attributes: { type: number; hex: string; text: string }[];
}

export function useTestUser() {
  return useMutation({
    mutationFn: async ({ username, password }: { username: string; password: string }) =>
      (await api.post<TestAuthResult>(`/users/${encodeURIComponent(username)}/test`, { password }))
        .data,
  });
}

export function useBulkCreateUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      rows: {
        username: string;
        password: string;
        passwordType?: 'cleartext' | 'nt';
        groups?: string[];
      }[],
    ) =>
      (
        await api.post<{ created: string[]; skipped: { username: string; reason: string }[] }>(
          '/users/bulk',
          { rows },
        )
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useDisconnectUserSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) =>
      (
        await api.post<{ total: number; results: unknown[]; errors: unknown[] }>(
          `/users/${encodeURIComponent(username)}/disconnect`,
        )
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

/* ------------------------------ Grupos ------------------------------ */

export function useGroups() {
  return useQuery({
    queryKey: ['groups'],
    queryFn: async () => (await api.get<GroupSummary[]>('/groups')).data,
  });
}

export function useGroup(name: string | null) {
  return useQuery({
    queryKey: ['group', name],
    enabled: !!name,
    queryFn: async () => (await api.get<GroupDetail>(`/groups/${encodeURIComponent(name!)}`)).data,
  });
}

export function useSaveGroup(mode: 'create' | 'update') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      groupname: string;
      checks: GroupDetail['checks'];
      replies: GroupDetail['replies'];
    }) => {
      if (mode === 'create') return (await api.post('/groups', input)).data;
      return (await api.put(`/groups/${encodeURIComponent(input.groupname)}`, input)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groups'] });
      qc.invalidateQueries({ queryKey: ['group'] });
    },
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, force }: { name: string; force?: boolean }) => {
      await api.delete(`/groups/${encodeURIComponent(name)}`, { params: { force } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['groups'] }),
  });
}

/* ----------------------------- Sesiones ----------------------------- */

export function useActiveSessions(params: {
  search: string;
  limit: number;
  offset: number;
  refetchMs?: number;
}) {
  const { refetchMs, ...q } = params;
  return useQuery({
    queryKey: ['sessions', 'active', q],
    refetchInterval: refetchMs ?? false,
    queryFn: async () =>
      (await api.get<Paged<Session> & { coaEnabled: boolean }>('/sessions/active', { params: q }))
        .data,
  });
}

export function useSessionHistory(params: {
  username?: string;
  nasipaddress?: string;
  from?: string;
  to?: string;
  limit: number;
  cursor?: number;
}) {
  return useQuery({
    queryKey: ['sessions', 'history', params],
    queryFn: async () =>
      (
        await api.get<{ items: Session[]; total: number | null; nextCursor: number | null }>(
          '/sessions',
          { params },
        )
      ).data,
  });
}

export function useDisconnectSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (acctuniqueid: string) =>
      (await api.post(`/sessions/${encodeURIComponent(acctuniqueid)}/disconnect`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
}

/* -------------------------------- NAS ------------------------------- */

export function useNasList() {
  return useQuery({
    queryKey: ['nas'],
    queryFn: async () => (await api.get<Nas[]>('/nas')).data,
  });
}

export function useNasProbe() {
  return useMutation({
    mutationFn: async (id: number) =>
      (await api.get<{ nasname: string; port: number; responded: boolean }>(`/nas/${id}/probe`))
        .data,
  });
}

export async function fetchClientsConf(id: number): Promise<string> {
  return (await api.get(`/nas/${id}/clients-conf`, { responseType: 'text' })).data as string;
}

export function useSaveNas(mode: 'create' | 'update') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Nas> & { nasname: string; secret: string; id?: number }) => {
      if (mode === 'create') return (await api.post<Nas>('/nas', input)).data;
      return (await api.put<Nas>(`/nas/${input.id}`, input)).data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nas'] }),
  });
}

export function useDeleteNas() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/nas/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nas'] }),
  });
}

/* ----------------------------- Reportes ---------------------------- */

export function useOverview(days: number) {
  return useQuery({
    queryKey: ['reports', 'overview', days],
    queryFn: async () => (await api.get<Overview>('/reports/overview', { params: { days } })).data,
  });
}

export function useTopUsers(params: { days: number; metric: 'traffic' | 'time'; limit: number }) {
  return useQuery({
    queryKey: ['reports', 'top-users', params],
    queryFn: async () => (await api.get<TopUser[]>('/reports/top-users', { params })).data,
  });
}

export function useAuthFailures(params: { days: number; limit: number }) {
  return useQuery({
    queryKey: ['reports', 'auth-failures', params],
    queryFn: async () => (await api.get<AuthFailure[]>('/reports/auth-failures', { params })).data,
  });
}

export function useTerminateCauses(days: number) {
  return useQuery({
    queryKey: ['reports', 'terminate-causes', days],
    queryFn: async () =>
      (
        await api.get<{ cause: string; count: number }[]>('/reports/terminate-causes', {
          params: { days },
        })
      ).data,
  });
}

export function useTopNas(days: number) {
  return useQuery({
    queryKey: ['reports', 'top-nas', days],
    queryFn: async () =>
      (
        await api.get<{ nasipaddress: string; sessions: number; users: number; gb: number }[]>(
          '/reports/top-nas',
          { params: { days } },
        )
      ).data,
  });
}

export function useInactiveUsers(params: { days: number; limit: number }) {
  return useQuery({
    queryKey: ['reports', 'inactive-users', params],
    queryFn: async () =>
      (
        await api.get<{ username: string; lastAuth: string | null }[]>('/reports/inactive-users', {
          params,
        })
      ).data,
  });
}

/* ------------------------------ Admins ----------------------------- */

export function useAdmins() {
  return useQuery({
    queryKey: ['admins'],
    queryFn: async () => (await api.get<Admin[]>('/admins')).data,
  });
}

export function useCreateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { username: string; password: string; role: 'admin' | 'operator' }) =>
      (await api.post<Admin>('/admins', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
}

export function useUpdateAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...input
    }: {
      id: number;
      password?: string;
      role?: 'admin' | 'operator';
      active?: boolean;
    }) => (await api.put<Admin>(`/admins/${id}`, input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
}

export function useDeleteAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/admins/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
}

/* ----------------------------- Auditoria --------------------------- */

export function useAuditLog(params: {
  entity?: string;
  action?: string;
  admin?: string;
  limit: number;
  offset: number;
}) {
  return useQuery({
    queryKey: ['audit', params],
    queryFn: async () => (await api.get<Paged<AuditEntry>>('/audit', { params })).data,
  });
}

export type { UserGroup };
