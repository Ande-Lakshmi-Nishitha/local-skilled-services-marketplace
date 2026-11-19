import Link from 'next/link';
import { notFound } from 'next/navigation';
import { bookSlot, withdrawRequest } from '../../../actions';
import { Bar, Empty, Flash, PageHeader, Pill, Stars } from '@/components/ui';
import { toAppError } from '@/lib/errors';
import { fmtDateTime, fmtTime, inr } from '@/lib/format';
import { requireRole } from '@/lib/session';
import { listCategories, listLocalities } from '@/lib/services/catalogue';
import { findMatches, getRequest, keywordBaseline, matchOptions, type Match } from '@/lib/services/requests';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function RequestPage({ params, searchParams }: Props) {
  const s = await requireRole('customer');
  const { id } = await params;
  const sp = await searchParams;
  const requestId = Number(id);
  if (!Number.isInteger(requestId)) notFound();

  const req = await getRequest(requestId, s.id).catch(() => null);
  if (!req) notFound();

  const locality = typeof sp.locality === 'string' && sp.locality ? sp.locality : null;
  const categoryId = typeof sp.category === 'string' && sp.category ? Number(sp.category) : null;
  const back = `/customer/requests/${requestId}${locality || categoryId ? `?${new URLSearchParams({ ...(locality ? { locality } : {}), ...(categoryId ? { category: String(categoryId) } : {}) })}` : ''}`;

  let matches: Match[] = [];
  let matchError: string | null = null;
  const t = Date.now();
  if (req.status === 'open') {
    try {
      matches = await findMatches(requestId, s.id, { locality, categoryId });
    } catch (e) {
      matchError = toAppError(e).message;
    }
  }
  const ms = Date.now() - t;
  const [cats, localities, keyword] = await Promise.all([listCategories(), listLocalities(), keywordBaseline(req.description)]);
  const top = matches[0]?.similarity ?? 0;
  const o = matchOptions();

  return (
    <div>
      <PageHeader title={`“${req.description}”`} back={{ href: '/customer', label: 'My requests' }}
        sub={<>Posted {fmtDateTime(req.created_at)} · <Pill s={req.status} /></>}>
        {req.status === 'open' && (
          <form action={withdrawRequest}><input type="hidden" name="request_id" value={requestId} /><button className="btn-ghost btn-sm">Withdraw request</button></form>
        )}
      </PageHeader>
      <Flash sp={sp} />

      {req.status !== 'open' ? (
        <Empty>This request is {req.status}. <Link className="link" href="/customer">Back to your bookings</Link></Empty>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
          <section>
            <form className="mb-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="label" htmlFor="locality">Area</label>
                <select id="locality" name="locality" defaultValue={locality ?? ''} className="input w-44">
                  <option value="">Anywhere</option>
                  {localities.map((l) => <option key={l}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="category">Trade</label>
                <select id="category" name="category" defaultValue={categoryId ?? ''} className="input w-44">
                  <option value="">Any trade</option>
                  {cats.map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
                </select>
              </div>
              <button className="btn-ghost">Filter</button>
              <span className="muted ml-auto">{matches.length} match{matches.length === 1 ? '' : 'es'} · {ms} ms</span>
            </form>

            {matchError && <div className="mb-4 rounded-lg border border-[#f0c4c0] bg-bad-soft px-4 py-3 text-sm text-bad">{matchError}</div>}
            {!matchError && matches.length > 0 && top < 0.35 && (
              <div className="mb-4 rounded-lg border border-[#f5d7a8] bg-warn-soft px-4 py-3 text-sm text-warn">
                No strong matches - these are the closest workers we found. Try describing the problem in more detail.
              </div>
            )}
            {!matchError && matches.length === 0 && (
              <Empty>No available, verified worker matches this closely enough{locality || categoryId ? ' with these filters' : ''}. Try removing filters or adding detail.</Empty>
            )}

            <div className="space-y-4">
              {matches.map((m, i) => (
                <article key={m.worker_id} className="card">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex gap-3">
                      {m.portfolio?.photo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={m.portfolio.photo_url} alt="" className="h-14 w-14 rounded-lg object-cover" />
                        : <div className="grid h-14 w-14 place-items-center rounded-lg bg-brand-soft text-lg font-semibold text-brand">{m.name[0]}</div>}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-muted">#{i + 1}</span>
                          <Link href={`/workers/${m.worker_id}?request=${requestId}`} className="font-semibold hover:underline">{m.name}</Link>
                        </div>
                        <div className="muted">{m.categories.join(', ')} · {m.locality} · {inr(m.hourly_rate)}/h</div>
                        <Stars avg={m.avg_rating} count={m.rating_count} />
                      </div>
                    </div>
                    <div className="space-y-1 text-right">
                      <Bar value={m.similarity} label={`match ${(m.similarity * 100).toFixed(0)}%`} />
                      <Bar value={m.trust_score} max={5} label={`trust ${m.trust_score.toFixed(2)}`} />
                      <div className="text-xs text-muted">score {m.final_score.toFixed(3)}</div>
                    </div>
                  </div>
                  <p className="mt-3 text-sm">{m.bio}</p>
                  {m.portfolio?.skills.length ? <div className="mt-2 flex flex-wrap gap-1">{m.portfolio.skills.map((k) => <span key={k} className="chip">{k}</span>)}</div> : null}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted">Book a slot:</span>
                    {m.slots.map((sl) => (
                      <form key={sl.slot_id} action={bookSlot}>
                        <input type="hidden" name="request_id" value={requestId} />
                        <input type="hidden" name="worker_id" value={m.worker_id} />
                        <input type="hidden" name="slot_id" value={sl.slot_id} />
                        <input type="hidden" name="back" value={back} />
                        <button className="btn-ghost btn-sm">{fmtDateTime(sl.start_time)}–{fmtTime(sl.end_time)}</button>
                      </form>
                    ))}
                    <Link href={`/workers/${m.worker_id}?request=${requestId}`} className="link text-xs">more times / profile →</Link>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside className="space-y-4">
            <div className="card">
              <h3 className="text-sm font-semibold">How ranking works</h3>
              <p className="muted mt-2 text-xs leading-relaxed">
                Your words were turned into a 384-number vector and compared with every worker&apos;s skills and bio (pgvector, HNSW index).
                Only verified workers with a free slot are shown. Score = {o.alpha} × match + {(1 - o.alpha).toFixed(1)} × trust,
                where trust is a Bayesian average of ratings (a single 5★ review does not beat many 4.7★ ones).
              </p>
            </div>
            <div className="card">
              <h3 className="text-sm font-semibold">Plain keyword search would find</h3>
              {keyword.length === 0 ? <p className="mt-2 text-sm text-bad">Nobody - none of your words appear in any profile.</p> : (
                <ul className="mt-2 space-y-1 text-sm">
                  {keyword.slice(0, 8).map((k) => (
                    <li key={k.worker_id}>{k.name} <span className="text-xs text-muted">({k.matched.join(', ')})</span></li>
                  ))}
                </ul>
              )}
              <p className="muted mt-2 text-xs">For comparison only: any of your words in a bio or trade name.</p>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
