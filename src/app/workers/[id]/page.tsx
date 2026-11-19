import Link from 'next/link';
import { notFound } from 'next/navigation';
import { bookSlot } from '../../actions';
import { Attributes, Empty, Flash, PageHeader, Pill, Stars } from '@/components/ui';
import { one } from '@/lib/db';
import { fmtDate, fmtDateTime, fmtTime, inr } from '@/lib/format';
import { getSession } from '@/lib/session';
import { openSlots } from '@/lib/services/slots';
import { getWorkerProfile } from '@/lib/services/workers';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function WorkerProfilePage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const workerId = Number(id);
  if (!Number.isInteger(workerId)) notFound();
  const [w, s] = await Promise.all([getWorkerProfile(workerId), getSession()]);
  if (!w) notFound();
  const own = s?.role === 'worker' && s.id === workerId;
  if (w.verification_status !== 'verified' && !own && s?.role !== 'admin') notFound();

  const slots = await openSlots(workerId, 21);
  const requestId = typeof sp.request === 'string' ? Number(sp.request) : NaN;
  const req = s?.role === 'customer' && Number.isInteger(requestId)
    ? await one<{ request_id: number; description: string }>(
        `SELECT request_id, description FROM service_request WHERE request_id = $1 AND customer_id = $2 AND status = 'open'`, [requestId, s.id])
    : null;
  const p = w.portfolio;
  const back = req ? { href: `/customer/requests/${req.request_id}`, label: 'Back to matches' } : undefined;

  return (
    <div>
      <PageHeader title={w.name} back={back}
        sub={<>{w.categories.map((c) => c.name).join(', ')} · {w.locality} · {inr(w.hourly_rate)}/hour {w.verification_status !== 'verified' && <Pill s={w.verification_status} />}</>}>
        <div className="text-right">
          <Stars avg={w.avg_rating} count={w.rating_count} />
          <div className="text-xs text-muted">trust score {w.bayesian.toFixed(2)} · {w.completed_jobs} jobs completed</div>
        </div>
      </PageHeader>
      <Flash sp={sp} />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <section className="card">
            <h2 className="h2 mb-2">About</h2>
            <p className="text-sm">{w.bio || <span className="text-muted">No bio yet.</span>}</p>
          </section>

          <section className="card">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="h2">Portfolio</h2>
              <span className="text-xs text-muted">stored in MongoDB · shape depends on the trade</span>
            </div>
            {!p ? <p className="muted">No portfolio yet.</p> : (
              <div className="space-y-4">
                <div className="text-sm"><span className="label inline">Trade</span> {p.trade}</div>
                {p.trade_attributes.skills?.length ? (
                  <div className="flex flex-wrap gap-1">{p.trade_attributes.skills.map((k) => <span key={k} className="chip">{k}</span>)}</div>
                ) : null}
                <Attributes attrs={p.trade_attributes} />
                {p.certifications.length > 0 && (
                  <div>
                    <div className="label">Certifications</div>
                    <ul className="list-disc pl-5 text-sm">
                      {p.certifications.map((c, i) => <li key={i}>{c.name}{c.issuer ? `, ${c.issuer}` : ''}{c.issued_year ? ` (${c.issued_year})` : ''}{c.number ? ` · ${c.number}` : ''}</li>)}
                    </ul>
                  </div>
                )}
                {p.photos.length > 0 && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {p.photos.map((ph) => (
                      <figure key={ph.url}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={ph.url} alt={ph.caption ?? ''} className="aspect-[4/3] w-full rounded-lg object-cover" />
                        {ph.caption && <figcaption className="mt-1 text-xs text-muted">{ph.caption}</figcaption>}
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="h2 mb-3">Recent reviews</h2>
            {w.recent_ratings.length === 0 ? <p className="muted">No reviews yet.</p> : (
              <ul className="space-y-3">
                {w.recent_ratings.map((r, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-[#c98a00]">{'★'.repeat(r.score)}{'☆'.repeat(5 - r.score)}</span>
                    <span className="ml-2 text-xs text-muted">{fmtDate(r.created_at)}</span>
                    {r.comment && <p>{r.comment}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="card h-fit">
          <h2 className="h2 mb-1">Available times</h2>
          {req ? <p className="muted mb-3">Booking for: “{req.description}”</p>
            : s?.role === 'customer' ? <p className="muted mb-3"><Link className="link" href="/customer">Post a request</Link> first, then book from its matches.</p>
            : <p className="muted mb-3">Customers book these from their request&apos;s matches.</p>}
          {slots.length === 0 ? <Empty>No open slots.</Empty> : (
            <ul className="space-y-2">
              {slots.map((sl) => (
                <li key={sl.slot_id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{fmtDateTime(sl.start_time)} – {fmtTime(sl.end_time)}</span>
                  {req && (
                    <form action={bookSlot}>
                      <input type="hidden" name="request_id" value={req.request_id} />
                      <input type="hidden" name="worker_id" value={workerId} />
                      <input type="hidden" name="slot_id" value={sl.slot_id} />
                      <input type="hidden" name="back" value={`/workers/${workerId}?request=${req.request_id}`} />
                      <button className="btn-primary btn-sm">Book</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
