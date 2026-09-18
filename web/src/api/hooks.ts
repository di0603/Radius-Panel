import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/* ------------------------------- Meta ----------------------------- */

export interface Meta {
  name: string;
  version: string;
  coaEnabled: boolean;
  testAuthEnabled: boolean;
  googleEnabled: boolean;
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
  Anomaly,
  ConcurrencyPoint,
  DurationBucket,
  HeatmapCell,
  NasStats,
  PeriodMetric,
  AuditEntry,
  AuthFailure,
  GroupDetail,
  GroupSummary,
  Nas,
  Overview,
  Paged,
  PanelSession,
  Session,
  TopUser,
  TotpEnrollment,
  UserActivity,
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

/* -------------------------- Cuenta y seguridad --------------------- */

export function usePanelSessions() {
  return useQuery({
    queryKey: ['panel-sessions'],
    queryFn: async () => (await api.get<{ items: PanelSession[] }>('/auth/sessions')).data.items,
  });
}

export function useRevokePanelSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/auth/sessions/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['panel-sessions'] }),
  });
}

export function useRevokeAllPanelSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.delete<{ revoked: number }>('/auth/sessions')).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['panel-sessions'] }),
  });
}

export function useChangeOwnPassword() {
  return useMutation({
    mutationFn: async (input: { currentPassword: string; newPassword: string }) =>
      (await api.post<{ ok: boolean }>('/auth/password', input)).data,
  });
}

/** Auto-servicio: fija el propio email para poder vincular el login con Google. */
export function useSetOwnEmail() {
  return useMutation({
    mutationFn: async (email: string) =>
      (await api.put<{ ok: boolean; email: string }>('/auth/email', { email })).data,
  });
}

export function useStartTotpSetup() {
  return useMutation({
    mutationFn: async () => (await api.post<TotpEnrollment>('/auth/2fa/setup')).data,
  });
}

export function useConfirmTotp() {
  return useMutation({
    mutationFn: async (code: string) =>
      (await api.post<{ enabled: boolean }>('/auth/2fa/confirm', { code })).data,
  });
}

export function useDisableTotp() {
  return useMutation({
    mutationFn: async (password: string) =>
      (await api.delete<{ enabled: boolean }>('/auth/2fa', { data: { password } })).data,
  });
}

export function useUnlockAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) =>
      (await api.post<{ ok: boolean }>(`/admins/${id}/unlock`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
}

export type { UserGroup };

/* ------------------------------ Analitica ------------------------------ */

export function useHeatmap(days: number) {
  return useQuery({
    queryKey: ['heatmap', days],
    queryFn: async () =>
      (await api.get<HeatmapCell[]>('/reports/heatmap', { params: { days } })).data,
  });
}

export function useConcurrency(days: number) {
  return useQuery({
    queryKey: ['concurrency', days],
    queryFn: async () =>
      (await api.get<ConcurrencyPoint[]>('/reports/concurrency', { params: { days } })).data,
  });
}

export function useNasStats(days: number) {
  return useQuery({
    queryKey: ['nas-stats', days],
    queryFn: async () =>
      (await api.get<NasStats[]>('/reports/nas-stats', { params: { days } })).data,
  });
}

export function useSessionDurations(days: number) {
  return useQuery({
    queryKey: ['session-durations', days],
    queryFn: async () =>
      (await api.get<DurationBucket[]>('/reports/session-durations', { params: { days } })).data,
  });
}

export function usePeriodComparison(days: number) {
  return useQuery({
    queryKey: ['period-comparison', days],
    queryFn: async () =>
      (await api.get<PeriodMetric[]>('/reports/period-comparison', { params: { days } })).data,
  });
}

export function useAnomalies(params: { days: number; limit: number }) {
  return useQuery({
    queryKey: ['anomalies', params],
    queryFn: async () => (await api.get<Anomaly[]>('/reports/anomalies', { params })).data,
  });
}

export function useUserActivity(username: string | null) {
  return useQuery({
    queryKey: ['user-activity', username],
    enabled: !!username,
    queryFn: async () =>
      (await api.get<UserActivity>(`/users/${encodeURIComponent(username!)}/activity`)).data,
  });
}
