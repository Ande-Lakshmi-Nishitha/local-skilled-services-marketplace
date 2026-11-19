// Display helpers. Everything is stored in UTC (timestamptz) and shown in India time.
export const TZ = 'Asia/Kolkata';

const dt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const d = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const t = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

export const fmtDateTime = (v: Date | string) => dt.format(new Date(v));
export const fmtDate = (v: Date | string) => d.format(new Date(v));
export const fmtTime = (v: Date | string) => t.format(new Date(v));
export const fmtSlot = (start: Date | string, end: Date | string) => `${fmtDateTime(start)} – ${fmtTime(end)}`;
export const inr = (n: number | string) =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function relHours(v: Date | string): string {
  const h = (new Date(v).getTime() - Date.now()) / 3_600_000;
  if (h < 0) return `${Math.round(-h)} h ago`;
  if (h < 48) return `in ${Math.round(h)} h`;
  return `in ${Math.round(h / 24)} days`;
}
