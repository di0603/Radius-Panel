const nf = new Intl.NumberFormat('es-ES');

export function formatNumber(n: number | null | undefined): string {
  return nf.format(Number(n ?? 0));
}

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(seconds ?? 0)));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || (!d && !h)) parts.push(`${m}m`);
  return parts.join(' ');
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('es-ES');
}

const shortDate = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' });

/** "2026-09-18" -> "18 sept". Para ejes de graficas. */
export function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(value) : shortDate.format(d);
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(decimals).replace('.', ',')} %`;
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return value;
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.round(h / 24);
  return `hace ${days} d`;
}
