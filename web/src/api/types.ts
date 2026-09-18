export type Role = 'admin' | 'operator';

export interface AuthUser {
  id?: number;
  sub?: number;
  username: string;
  role: Role;
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
