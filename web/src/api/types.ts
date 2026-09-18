export type Role = 'admin' | 'operator';

export interface AuthUser {
  id?: number;
  sub?: number;
  username: string;
  role: Role;
  totpEnabled?: boolean;
  email?: string | null;
  googleLinked?: boolean;
}

/** Sesion abierta del panel (un refresh token vivo). */
export interface PanelSession {
  id: number;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
  ip: string;
  user_agent: string;
}

export interface TotpEnrollment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export interface AttrRow {
  attribute: string;
  op: string;
  value: string;
}

export interface UserGroup {
  groupname: string;
  priority: number;
}

export interface UserSummary {
  username: string;
  hasPassword: boolean;
  passwordType: 'cleartext' | 'nt' | 'other' | null;
  disabled: boolean;
  replyCount: number;
  groups: string[];
}

export interface UserDetail {
  username: string;
  checks: AttrRow[];
  replies: AttrRow[];
  groups: UserGroup[];
}

export interface UserWriteInput {
  username: string;
  password?: string | null;
  passwordType: 'cleartext' | 'nt';
  checks: AttrRow[];
  replies: AttrRow[];
  groups: UserGroup[];
}

export interface GroupSummary {
  groupname: string;
  checkCount: number;
  replyCount: number;
  memberCount: number;
}

export interface GroupDetail {
  groupname: string;
  checks: AttrRow[];
  replies: AttrRow[];
  memberCount: number;
}

export interface Session {
  radacctid: number;
  acctsessionid: string;
  acctuniqueid: string;
  username: string;
  nasipaddress: string;
  nasportid: string | null;
  acctstarttime: string | null;
  acctupdatetime: string | null;
  acctstoptime: string | null;
  acctsessiontime: number | null;
  acctinputoctets: number | null;
  acctoutputoctets: number | null;
  callingstationid: string;
  calledstationid: string;
  framedipaddress: string;
  acctterminatecause: string;
}

export interface Nas {
  id: number;
  nasname: string;
  shortname: string | null;
  type: string | null;
  ports: number | null;
  secret: string;
  server: string | null;
  community: string | null;
  description: string | null;
}

export interface Overview {
  rangeDays: number;
  totals: { users: number; activeSessions: number; accepts: number; rejects: number };
  loginsByDay: { date: string; accepts: number; rejects: number }[];
  trafficByDay: { date: string; inputGb: number; outputGb: number }[];
}

export interface TopUser {
  username: string;
  inputOctets: number;
  outputOctets: number;
  sessionTime: number;
  sessions: number;
}

export interface AuthFailure {
  username: string;
  failures: number;
  lastAt: string;
}

export interface Admin {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  /** Fecha hasta la que la cuenta esta bloqueada por intentos fallidos. */
  locked_until: string | null;
  totp_enabled: boolean;
}

export interface AuditEntry {
  id: number;
  admin_name: string;
  action: string;
  entity: string;
  entity_id: string;
  detail: unknown;
  ip: string;
  created_at: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

/* ------------------------------ Analitica ------------------------------ */

export interface HeatmapCell {
  /** 1 = domingo ... 7 = sabado. */
  weekday: number;
  hour: number;
  accepts: number;
  rejects: number;
}

export interface ConcurrencyPoint {
  date: string;
  peak: number;
  peakHour: number;
}

export interface NasStats {
  nasipaddress: string;
  sessions: number;
  users: number;
  activeNow: number;
  gb: number;
  avgSessionMinutes: number;
  lastSeen: string | null;
}

export interface DurationBucket {
  label: string;
  sessions: number;
}

export interface PeriodMetric {
  label: string;
  current: number;
  previous: number;
  changePct: number | null;
}

export interface Anomaly {
  kind: 'long-session' | 'heavy-traffic' | 'flapping';
  username: string;
  nasipaddress: string;
  detail: string;
  value: number;
  at: string | null;
}

export interface UserActivity {
  sessions: {
    acctuniqueid: string;
    nasipaddress: string;
    framedipaddress: string;
    acctstarttime: string | null;
    acctstoptime: string | null;
    acctsessiontime: number | null;
    bytes: number;
    acctterminatecause: string;
  }[];
  auths: { reply: string; authdate: string; accepted: boolean }[];
  totals: { sessions: number; bytes: number; seconds: number; accepts: number; rejects: number };
}
