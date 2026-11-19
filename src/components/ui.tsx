import Link from 'next/link';
import type { ReactNode } from 'react';

type SP = Record<string, string | string[] | undefined>;

/** Success / error banner driven by ?ok= and ?err= (set by the server actions after a redirect). */
export function Flash({ sp }: { sp: SP }) {
  const ok = typeof sp.ok === 'string' ? sp.ok : null;
  const err = typeof sp.err === 'string' ? sp.err : null;
  if (!ok && !err) return null;
  return (
    <div data-flash role={err ? 'alert' : 'status'}
      className={`mb-5 rounded-lg border px-4 py-3 text-sm ${err ? 'border-[#f0c4c0] bg-bad-soft text-bad' : 'border-[#bfe0d7] bg-brand-soft text-brand'}`}>
      {err ?? ok}
    </div>
  );
}

const PILL: Record<string, string> = {
  open: 'bg-brand-soft text-brand', confirmed: 'bg-brand-soft text-brand', verified: 'bg-brand-soft text-brand',
  paid: 'bg-brand-soft text-brand', success: 'bg-brand-soft text-brand', resolved: 'bg-brand-soft text-brand',
  completed: 'bg-[#e8eefc] text-[#2747a8]', booked: 'bg-[#e8eefc] text-[#2747a8]', reserved: 'bg-[#e8eefc] text-[#2747a8]', closed: 'bg-[#eeeeee] text-[#555]',
  pending: 'bg-warn-soft text-warn', issued: 'bg-warn-soft text-warn', partially_refunded: 'bg-warn-soft text-warn', blocked: 'bg-[#eeeeee] text-[#555]',
  cancelled: 'bg-bad-soft text-bad', rejected: 'bg-bad-soft text-bad', no_show: 'bg-bad-soft text-bad', void: 'bg-[#eeeeee] text-[#555]', refunded: 'bg-[#eeeeee] text-[#555]',
};

export function Pill({ s }: { s: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PILL[s] ?? 'bg-paper text-ink'}`}>{s.replace(/_/g, ' ')}</span>;
}

export function Stars({ avg, count }: { avg: number | null; count: number }) {
  if (avg === null || count === 0) return <span className="muted">No ratings yet</span>;
  return (
    <span className="text-sm" title={`${avg.toFixed(2)} average from ${count} ratings`}>
      <span className="text-[#c98a00]">{'★'.repeat(Math.round(avg))}{'☆'.repeat(5 - Math.round(avg))}</span>{' '}
      <span className="font-medium">{avg.toFixed(1)}</span> <span className="text-muted">({count})</span>
    </span>
  );
}

export function Bar({ value, max = 1, label }: { value: number; max?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="flex items-center gap-2" title={label}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line"><div className="h-full bg-brand" style={{ width: `${pct}%` }} /></div>
      {label && <span className="text-xs tabular-nums text-muted">{label}</span>}
    </div>
  );
}

export function PageHeader({ title, sub, back, children }: { title: string; sub?: ReactNode; back?: { href: string; label: string }; children?: ReactNode }) {
  return (
    <div className="mb-6">
      {back && <Link href={back.href} className="link text-sm">← {back.label}</Link>}
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">{title}</h1>
          {sub && <div className="muted mt-1">{sub}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{children}</div>;
}

/** Render free-form MongoDB trade_attributes generically: arrays become chips, objects become "key: value". */
export function Attributes({ attrs }: { attrs: Record<string, unknown> }) {
  const entries = Object.entries(attrs).filter(([k]) => k !== 'skills');
  if (!entries.length) return null;
  const show = (v: unknown): ReactNode => {
    if (Array.isArray(v)) return <span className="flex flex-wrap gap-1">{v.map((x, i) => <span key={i} className="chip">{typeof x === 'object' && x ? Object.values(x).join(' · ') : String(x)}</span>)}</span>;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'string' && /^https:\/\//.test(v)) return <a className="link" href={v} rel="noreferrer nofollow" target="_blank">{v}</a>;
    if (typeof v === 'object' && v) return JSON.stringify(v);
    return String(v);
  };
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{k.replace(/_/g, ' ')}</dt>
          <dd className="text-sm">{show(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
