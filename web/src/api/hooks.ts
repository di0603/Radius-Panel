import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/* ------------------------------- Meta ----------------------------- */

export interface Meta {
  name: string;
  version: string;
  coaEnabled: boolean;
  testAuthEnabled: boolean;
  googleEnabled: boolean;
  vpnEnabled: boolean;
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

/* ------------------------------ PKI (VPN) --------------------------- */

export type PkiCaStatus = 'pending' | 'active' | 'retiring' | 'retired';

export interface PkiCaSummary {
  id: number;
  status: PkiCaStatus;
  subjectCn: string | null;
  serial: string | null;
  spkiSha256: string | null;
  notBefore: string | null;
  notAfter: string | null;
  crlNumber: number;
  crlLastGeneratedAt: string | null;
  crlNextUpdate: string | null;
  createdAt: string;
  /** true si esta 'retired' sin haber llegado a activarse: una CA RSA obsoleta (ahora solo ECDSA P-384). */
  staleAlgorithm: boolean;
}

export interface PkiRootSummary {
  subjectCn: string;
  serial: string;
  notAfter: string;
}

export interface PkiStatus {
  root: PkiRootSummary | null;
  intermediates: PkiCaSummary[];
  activeDeviceCertificates: number;
}

export function usePkiStatus() {
  return useQuery({
    queryKey: ['pki-status'],
    queryFn: async () => (await api.get<PkiStatus>('/pki/status')).data,
  });
}

export function useGenerateIntermediate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (subjectCn: string) =>
      (
        await api.post<{ id: number; csrPem: string; subjectCn: string }>('/pki/intermediate', {
          subjectCn,
        })
      ).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pki-status'] }),
  });
}

export function useCancelPendingIntermediate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/pki/intermediate/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pki-status'] }),
  });
}

export function useImportIntermediate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      certPem,
      rootCertPem,
    }: {
      id: number;
      certPem: string;
      rootCertPem: string;
    }) =>
      (await api.post<PkiCaSummary>(`/pki/intermediate/${id}/import`, { certPem, rootCertPem }))
        .data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pki-status'] }),
  });
}

export function useRegenerateCrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) =>
      (await api.post<PkiStatus>(`/pki/intermediate/${id}/regenerate-crl`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pki-status'] }),
  });
}

/* --------------------------- Dispositivos VPN ------------------------ */

export type DevicePlatform = 'windows' | 'android' | 'linux';
export type TunnelMode = 'full' | 'split';
/** Derivado en el servidor de `enabled` + `framedIp`: no hay una columna de estado propia. */
export type DeviceStatus = 'active' | 'disabled' | 'decommissioned';

export type AccessProfile =
  | 'lan_restricted'
  | 'lan_full'
  | 'internet_only'
  | 'internet_lan_restricted'
  | 'internet_lan_full';

export interface VpnDevice {
  id: number;
  username: string;
  ownerUser: string;
  deviceLabel: string;
  ownerName: string | null;
  platform: DevicePlatform;
  tunnelMode: TunnelMode;
  accessProfile: AccessProfile;
  notes: string | null;
  certDays: number | null;
  renewAfterDays: number | null;
  framedIp: string | null;
  enabled: boolean;
  status: DeviceStatus;
  allowRadiusHost: boolean;
  allowMariadbHost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceCertificateSummary {
  serial: string;
  status: 'active' | 'superseded' | 'revoked';
  notBefore: string;
  notAfter: string;
  createdAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface VpnDeviceDetail extends VpnDevice {
  certificates: DeviceCertificateSummary[];
  lastIssuedAt: string | null;
  nextRenewalExpectedAt: string | null;
}

export function useVpnDevices() {
  return useQuery({
    queryKey: ['vpn-devices'],
    queryFn: async () => (await api.get<VpnDevice[]>('/vpn-devices')).data,
  });
}

export function useVpnDevice(username: string | null) {
  return useQuery({
    queryKey: ['vpn-devices', username],
    enabled: !!username,
    queryFn: async () =>
      (await api.get<VpnDeviceDetail>(`/vpn-devices/${encodeURIComponent(username!)}`)).data,
  });
}

export interface CreateVpnDeviceInput {
  ownerUser: string;
  deviceLabel: string;
  ownerName: string | null;
  platform: DevicePlatform;
  tunnelMode?: TunnelMode;
  accessProfile?: AccessProfile;
  notes: string | null;
  certDays: number | null;
  renewAfterDays: number | null;
}

export function useCreateVpnDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateVpnDeviceInput) =>
      (await api.post<VpnDevice>('/vpn-devices', input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-devices'] }),
  });
}

export interface SignedProfileEnvelope {
  payload: string;
  signature: string;
  keyId: string;
  /** SPKI DER (base64url) de la clave publica Ed25519 del panel: la app la aprende de aqui (cliente generico, sin clave incrustada, ver prompt 12.5). */
  signerPublicKey: string;
}

/** Huella SHA-256 formateada para comparar a ojo: grupos de 4 mayusculas, y "short" = los primeros 8 grupos. */
export interface FormattedFingerprint {
  full: string;
  short: string;
}

export interface EnrollTokenResult {
  id: number;
  token: string;
  expiresAt: string;
  /** `null` si el panel todavia no tiene configurada la firma de perfiles (VPN_PROFILE_SIGNING_KEY). */
  profile: SignedProfileEnvelope | null;
  profileQrDataUrl: string | null;
  profileFilename: string | null;
  /** Para que el admin las lea en voz alta o las compare con lo que muestra la app al confiar en este servidor por primera vez. `null` junto con `profile`. */
  panelKeyFingerprint: FormattedFingerprint | null;
  rootCaFingerprint: FormattedFingerprint | null;
}

export function useGenerateEnrollToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) =>
      (await api.post<EnrollTokenResult>(`/vpn-devices/${encodeURIComponent(username)}/enroll-token`)).data,
    onSuccess: (_data, username) => qc.invalidateQueries({ queryKey: ['vpn-devices', username] }),
  });
}

export function useSetVpnDeviceEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, enabled }: { username: string; enabled: boolean }) => {
      await api.patch(`/vpn-devices/${encodeURIComponent(username)}/enabled`, { enabled });
    },
    onSuccess: (_data, { username }) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices'] });
      qc.invalidateQueries({ queryKey: ['vpn-devices', username] });
    },
  });
}

export function useRevokeVpnDeviceCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, reason }: { username: string; reason: string }) => {
      await api.post(`/vpn-devices/${encodeURIComponent(username)}/revoke`, { reason });
    },
    onSuccess: (_data, { username }) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices'] });
      qc.invalidateQueries({ queryKey: ['vpn-devices', username] });
    },
  });
}

export interface AndroidCertIssued {
  password: string;
  downloadToken: string;
  expiresAt: string;
}

/**
 * Emite (o renueva) el certificado de un dispositivo Android: excepcion
 * documentada en la que el panel genera la clave (la app de Android no sabe
 * renovarse sola por EST). Devuelve la contrasena del .p12 y el token de
 * descarga en claro una unica vez.
 */
export function useIssueAndroidCertificate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) =>
      (
        await api.post<AndroidCertIssued>(`/vpn-devices/${encodeURIComponent(username)}/android-cert`)
      ).data,
    onSuccess: (_data, username) => qc.invalidateQueries({ queryKey: ['vpn-devices', username] }),
  });
}

/** Descarga el paquete de conexion (zip Windows / tar.gz Linux) y lo guarda en el navegador. */
export function useDownloadVpnDevicePackage() {
  return useMutation({
    mutationFn: async (username: string) => {
      const res = await api.get<Blob>(`/vpn-devices/${encodeURIComponent(username)}/package`, {
        responseType: 'blob',
      });
      const disposition = res.headers['content-disposition'] as string | undefined;
      const filename = disposition?.match(/filename="([^"]+)"/)?.[1] ?? `${username}.zip`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export function useDecommissionVpnDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (username: string) => {
      await api.delete(`/vpn-devices/${encodeURIComponent(username)}`);
    },
    onSuccess: (_data, username) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices'] });
      qc.invalidateQueries({ queryKey: ['vpn-devices', username] });
    },
  });
}

/* --------------------------- Alertas VPN (panel) ---------------------- */

export interface RenewalFailingAlert {
  username: string;
  platform: 'windows' | 'linux';
  notAfter: string | null;
  critical: boolean;
}

export interface AndroidExpiringAlert {
  username: string;
  notAfter: string;
}

export interface CaExpiringAlert {
  id: number;
  subjectCn: string | null;
  notAfter: string;
}

export interface VpnAlerts {
  renewalFailing: RenewalFailingAlert[];
  androidExpiringSoon: AndroidExpiringAlert[];
  caExpiringSoon: CaExpiringAlert[];
  estRejectionsLastHour: number;
  estRejectionsThreshold: number;
}

export function useVpnAlerts(enabled: boolean) {
  return useQuery({
    queryKey: ['vpn-alerts'],
    enabled,
    queryFn: async () => (await api.get<VpnAlerts>('/vpn-alerts')).data,
    refetchInterval: 60_000,
  });
}

/* ------------------------ Permisos de red (firewall) ------------------- */

export type DeviceRuleKind = 'internet' | 'lan' | 'custom';
export type DeviceRuleProtocol = 'tcp' | 'udp' | 'any';

export interface DeviceRule {
  id: number;
  kind: DeviceRuleKind;
  destCidr: string | null;
  protocol: DeviceRuleProtocol | null;
  port: number | null;
  createdAt: string;
}

export interface AddDeviceRuleInput {
  kind: DeviceRuleKind;
  destCidr?: string | null;
  protocol?: DeviceRuleProtocol | null;
  port?: number | null;
}

export function useDeviceRules(username: string | null) {
  return useQuery({
    queryKey: ['vpn-devices', username, 'rules'],
    enabled: !!username,
    queryFn: async () =>
      (await api.get<DeviceRule[]>(`/vpn-devices/${encodeURIComponent(username!)}/rules`)).data,
  });
}

export function useAddDeviceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, input }: { username: string; input: AddDeviceRuleInput }) =>
      (
        await api.post<DeviceRule>(`/vpn-devices/${encodeURIComponent(username)}/rules`, input)
      ).data,
    onSuccess: (_data, { username }) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices', username, 'rules'] });
    },
  });
}

export function useDeleteDeviceRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, ruleId }: { username: string; ruleId: number }) => {
      await api.delete(`/vpn-devices/${encodeURIComponent(username)}/rules/${ruleId}`);
    },
    onSuccess: (_data, { username }) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices', username, 'rules'] });
    },
  });
}

export function useSetDeviceOverrides() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      username,
      overrides,
    }: {
      username: string;
      overrides: { allowRadiusHost?: boolean; allowMariadbHost?: boolean };
    }) => {
      await api.patch(`/vpn-devices/${encodeURIComponent(username)}/overrides`, overrides);
    },
    onSuccess: (_data, { username }) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices'] });
      qc.invalidateQueries({ queryKey: ['vpn-devices', username] });
    },
  });
}

/* ------------------------------ Ajustes VPN ----------------------------- */

export interface VpnSettingsView {
  vpnFqdn: string;
  aaaId: string;
  poolStart: string;
  poolEnd: string;
  lanCidr: string;
  dns: string;
  deviceCertDays: number;
  renewAfterDays: number;
  overlapHours: number;
  androidCertDays: number;
  estUrl: string;
  gatewayTokenSet: boolean;
  /** `null` si esa pieza todavia no esta configurada (VPN_PROFILE_SIGNING_KEY / la raiz offline), independientes entre si. */
  panelKeyFingerprint: FormattedFingerprint | null;
  rootCaFingerprint: FormattedFingerprint | null;
}

export function useVpnSettings() {
  return useQuery({
    queryKey: ['vpn-settings'],
    queryFn: async () => (await api.get<VpnSettingsView>('/vpn-settings')).data,
  });
}

export function useGenerateGatewayToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<{ token: string }>('/vpn-settings/gateway-token')).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-settings'] }),
  });
}

/* ------------------------ Perfiles de acceso VPN (prompt 12.14) ------------------------ */

export interface AccessProfileInfo {
  profile: AccessProfile;
  label: string;
  description: string;
  internet: boolean;
  lan: 'none' | 'restricted' | 'full';
  infrastructureAccess: boolean;
}

export type ProfileRangesView = Record<
  AccessProfile,
  { rangeStart: string | null; rangeEnd: string | null }
>;

export type RestrictedProtocol = 'tcp' | 'udp' | 'icmp';

export interface RestrictedDestination {
  id: number;
  destCidr: string;
  protocol: RestrictedProtocol;
  ports: string | null;
  comment: string;
}

export interface RestrictedDestinationInput {
  destCidr: string;
  protocol: RestrictedProtocol;
  ports: string | null;
  comment: string | null;
}

export interface VpnProfilesView {
  profiles: AccessProfileInfo[];
  infrastructureWarning: string;
  noInternetWarning: string;
  /** IP de la VM VPN: la lista restringida no puede incluirla (entra por input, no por forward). */
  gatewayIp: string;
  ranges: ProfileRangesView;
  destinations: RestrictedDestination[];
  lanCidr: string;
  dhcp: { start: string; end: string } | null;
  reservedHosts: string[];
  egressInterface: string | null;
}

export function useVpnProfiles() {
  return useQuery({
    queryKey: ['vpn-profiles'],
    queryFn: async () => (await api.get<VpnProfilesView>('/vpn-profiles')).data,
  });
}

export function useSetProfileRanges() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ranges: ProfileRangesView) =>
      (await api.put<{ ranges: ProfileRangesView }>('/vpn-profiles/ranges', { ranges })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-profiles'] }),
  });
}

export function useSaveRestrictedDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: number | null; input: RestrictedDestinationInput }) =>
      id === null
        ? (await api.post<RestrictedDestination>('/vpn-profiles/destinations', input)).data
        : (await api.put<RestrictedDestination>(`/vpn-profiles/destinations/${id}`, input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-profiles'] }),
  });
}

export function useDeleteRestrictedDestination() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/vpn-profiles/destinations/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vpn-profiles'] }),
  });
}

/**
 * Descarga ficheros nftables de los perfiles: `sets` = vpn-profiles.nft (solo rellena los sets que ya
 * existen en inet filter; lo aplica a mano deploy/vpn-gateway-apply-profiles.sh) y `fragment` = fragmento
 * de /etc/nftables.conf (sets vacios + reglas fijas) para revisar e integrar una vez.
 */
export function useDownloadProfilesNft() {
  return useMutation({
    mutationFn: async (kind: 'sets' | 'fragment') => {
      const [path, filename] =
        kind === 'sets'
          ? ['/vpn-profiles/nft', 'vpn-profiles.nft']
          : ['/vpn-profiles/nftables-fragment', 'nftables-fragmento-perfiles.conf'];
      const res = await api.get<Blob>(path, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

export interface ChangeDeviceProfileResult {
  device: VpnDevice;
  changed: boolean;
  before: { accessProfile: AccessProfile; framedIp: string | null };
  after: { accessProfile: AccessProfile; framedIp: string | null };
  disconnect: { attempted: boolean; ok: boolean; sessions: number; error: string | null };
}

export function useChangeDeviceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ username, accessProfile }: { username: string; accessProfile: AccessProfile }) =>
      (
        await api.patch<ChangeDeviceProfileResult>(
          `/vpn-devices/${encodeURIComponent(username)}/access-profile`,
          { accessProfile },
        )
      ).data,
    onSuccess: (_data, { username }) => {
      qc.invalidateQueries({ queryKey: ['vpn-devices'] });
      qc.invalidateQueries({ queryKey: ['vpn-devices', username] });
    },
  });
}
