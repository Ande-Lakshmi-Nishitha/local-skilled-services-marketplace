import Link from 'next/link';
import { resolveDispute, reviewWorker } from '../actions';
import { Attributes, Empty, Flash, PageHeader, Pill } from '@/components/ui';
import { fmtDate, fmtDateTime, inr } from '@/lib/format';
import { requireRole } from '@/lib/session';
import { analytics, listDisputes, pendingWorkers } from '@/lib/services/admin';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Admin({ searchParams }: Props) {
  await requireRole('admin');
  const sp = await searchParams;
  const [{ kpis, categories, days }, pending, disputes] = await Promise.all([analytics(), pendingWorkers(), listDisputes()]);
  const maxCat = Math.max(1, ...categories.map((c) => Number(c.net_revenue)));
  const maxDay = Math.max(1, ...days.map((d) => Number(d.net_revenue)));
  const k = (name: string) => kpis?.[name] ?? 0;

  const tiles: [string, string | number][] = [
    ['Net revenue', inr(Number(k('net_revenue')))], ['Bookings', k('total_bookings')], ['Completed', k('completed')],
    ['Upcoming', k('confirmed')], ['Cancelled', k('cancelled')], ['No-show rate', `${k('no_show_rate_pct') ?? 0}%`],
    ['Average rating', k('avg_rating') ?? '–'], ['Verified workers', k('verified_workers')], ['Open disputes', k('open_disputes')],
  ];

  return (
    <div>
      <PageHeader title="Admin dashboard" sub="Numbers come from the views v_platform_kpis, v_category_stats and v_revenue_by_day.">
        <Link className="btn-ghost" href="/leaderboard">Leaderboard</Link>
      </PageHeader>
      <Flash sp={sp} />

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-9">
        {tiles.map(([t, v]) => (
          <div key={t} className="rounded-xl border border-line bg-white p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{String(v)}</div>
          </div>
        ))}
      </div>

      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="h2 mb-3">Revenue by category</h2>
          <table className="table">
            <thead><tr><th>Category</th><th>Bookings</th><th>Completed</th><th>Net revenue</th></tr></thead>
            <tbody>{categories.map((c) => (
              <tr key={c.category_name}>
                <td>{c.category_name}</td><td className="tabular-nums">{c.bookings}</td><td className="tabular-nums">{c.completed}</td>
                <td><div className="flex items-center gap-2"><div className="h-2 rounded bg-brand" style={{ width: `${(Number(c.net_revenue) / maxCat) * 90}px` }} /><span className="tabular-nums">{inr(c.net_revenue)}</span></div></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
        <section className="card">
          <h2 className="h2 mb-3">Net revenue, last 30 days</h2>
          {days.length === 0 ? <Empty>No payments in the last 30 days.</Empty> : (
            <div className="flex h-44 items-end gap-1" role="img" aria-label="Revenue per day">
              {days.map((d) => (
                <div key={String(d.day)} className="group relative flex-1" title={`${fmtDate(d.day)}: ${inr(d.net_revenue)} (${d.payments} payments)`}>
                  <div className="w-full rounded-t bg-brand" style={{ height: `${Math.max(3, (Number(d.net_revenue) / maxDay) * 160)}px` }} />
                </div>
              ))}
            </div>
          )}
          {days.length > 0 && <div className="mt-1 flex justify-between text-xs text-muted"><span>{fmtDate(days[0].day)}</span><span>{fmtDate(days[days.length - 1].day)}</span></div>}
        </section>
      </div>

      <section className="mb-8">
        <h2 className="h2 mb-3">Workers waiting for verification ({pending.length})</h2>
        {pending.length === 0 ? <Empty>Nobody is waiting.</Empty> : (
          <div className="grid gap-4 md:grid-cols-2">
            {pending.map((w) => (
              <article key={w.worker_id} className="card">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link className="font-semibold hover:underline" href={`/workers/${w.worker_id}`}>{w.name}</Link>
                    <div className="muted">{w.categories} · {w.locality} · {inr(w.hourly_rate)}/h · {w.email}</div>
                    <div className="text-xs text-muted">registered {fmtDateTime(w.created_at)}</div>
                  </div>
                  <Pill s="pending" />
                </div>
                <p className="mt-2 text-sm">{w.bio}</p>
                {w.portfolio && <div className="mt-3 rounded-lg bg-paper p-3"><div className="mb-2 text-xs text-muted">Portfolio: {w.portfolio.trade} · {w.portfolio.certifications.length} certifications</div><Attributes attrs={w.portfolio.trade_attributes} /></div>}
                <div className="mt-4 flex gap-2">
                  <form action={reviewWorker}><input type="hidden" name="worker_id" value={w.worker_id} /><input type="hidden" name="decision" value="verified" /><button className="btn-primary">Verify</button></form>
                  <form action={reviewWorker}><input type="hidden" name="worker_id" value={w.worker_id} /><input type="hidden" name="decision" value="rejected" /><button className="btn-danger">Reject</button></form>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section id="disputes">
        <h2 className="h2 mb-3">Disputes</h2>
        {disputes.length === 0 ? <Empty>No disputes.</Empty> : (
          <div className="space-y-3">
            {disputes.map((d) => {
              const refundable = Math.max(0, Number(d.paid) - Number(d.refunded));
              return (
                <article key={d.dispute_id} className="card">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="text-sm">
                      <Link className="link font-medium" href={`/bookings/${d.booking_id}`}>Booking #{d.booking_id}</Link> · {d.customer_name} ↔ {d.worker_name} · booking <Pill s={d.booking_status} />
                      <div className="text-xs text-muted">raised by {d.raised_by_role} · {fmtDateTime(d.created_at)} · paid {inr(d.paid)}, refunded {inr(d.refunded)}</div>
                    </div>
                    <Pill s={d.status} />
                  </div>
                  <p className="mt-2 text-sm">{d.reason}</p>
                  {d.resolution_note && <p className="mt-1 text-sm text-muted">Resolution: {d.resolution_note}</p>}
                  {d.status === 'open' && (
                    <form action={resolveDispute} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="dispute_id" value={d.dispute_id} />
                      <div><label className="label" htmlFor={`st${d.dispute_id}`}>Decision</label>
                        <select id={`st${d.dispute_id}`} name="status" className="input w-36"><option value="resolved">Resolve</option><option value="rejected">Reject</option></select></div>
                      <div><label className="label" htmlFor={`rf${d.dispute_id}`}>Refund (max {inr(refundable)})</label>
                        <input id={`rf${d.dispute_id}`} name="refund" type="number" min={0} max={refundable} step="0.01" defaultValue={0} className="input w-36" disabled={refundable === 0} /></div>
                      <div className="min-w-56 flex-1"><label className="label" htmlFor={`nt${d.dispute_id}`}>Note</label><input id={`nt${d.dispute_id}`} name="note" className="input" placeholder="What was decided" /></div>
                      <button className="btn-primary">Close dispute</button>
                    </form>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
