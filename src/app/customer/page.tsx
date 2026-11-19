import Link from 'next/link';
import { postRequest } from '../actions';
import { Empty, Flash, PageHeader, Pill } from '@/components/ui';
import { fmtDateTime, fmtSlot, inr, relHours } from '@/lib/format';
import { requireRole } from '@/lib/session';
import { listBookings } from '@/lib/services/bookings';
import { listRequests } from '@/lib/services/requests';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const EXAMPLES = [
  'Fan not spinning', 'AC rattling and not cooling', 'Tap dripping all night', 'Need help with class 10 algebra',
  'Cockroaches in the kitchen', 'Wardrobe door came off its hinge', 'Damp patch on the bedroom wall',
];

export default async function CustomerHome({ searchParams }: Props) {
  const s = await requireRole('customer');
  const sp = await searchParams;
  const [reqs, books] = await Promise.all([listRequests(s.id), listBookings('customer', s.id)]);
  const active = books.filter((b) => b.status === 'confirmed');
  const past = books.filter((b) => b.status !== 'confirmed').slice(0, 8);
  const prefill = typeof sp.q === 'string' ? sp.q : '';

  return (
    <div>
      <PageHeader title={`Hi ${s.name.split(' ')[0]}`} sub="Describe the problem in your own words. No need to know the trade." />
      <Flash sp={sp} />

      <form action={postRequest} className="card mb-8">
        <label htmlFor="description" className="label">What do you need help with?</label>
        <textarea id="description" name="description" required minLength={5} maxLength={1000} rows={3} defaultValue={prefill}
          className="input text-base" placeholder="e.g. The bedroom AC makes a rattling noise and the room never gets cold" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((e) => <Link key={e} href={`/customer?q=${encodeURIComponent(e)}`} className="chip hover:border-brand">{e}</Link>)}
          </div>
          <button className="btn-primary">Find workers</button>
        </div>
      </form>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="h2 mb-3">Upcoming and in-progress bookings</h2>
          {active.length === 0 ? <Empty>No active bookings.</Empty> : (
            <div className="space-y-3">
              {active.map((b) => (
                <Link key={b.booking_id} href={`/bookings/${b.booking_id}`} className="card block hover:border-brand">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{b.worker_name}</div>
                      <div className="muted">{b.description}</div>
                    </div>
                    <Pill s={b.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 text-sm">
                    <span>{fmtSlot(b.start_time, b.end_time)} <span className="text-muted">({relHours(b.start_time)})</span></span>
                    {b.amount !== null && <span>{inr(b.amount)} · <Pill s={b.invoice_status ?? ''} /></span>}
                  </div>
                </Link>
              ))}
            </div>
          )}

          <h2 className="h2 mb-3 mt-8">Past bookings</h2>
          {past.length === 0 ? <Empty>Nothing yet.</Empty> : (
            <table className="table">
              <thead><tr><th>Worker</th><th>When</th><th>Status</th><th>Rated</th></tr></thead>
              <tbody>
                {past.map((b) => (
                  <tr key={b.booking_id}>
                    <td><Link className="link" href={`/bookings/${b.booking_id}`}>{b.worker_name}</Link></td>
                    <td>{fmtDateTime(b.start_time)}</td>
                    <td><Pill s={b.status} /></td>
                    <td>{b.rating_score ? '★'.repeat(b.rating_score) : b.status === 'completed' ? <Link className="link" href={`/bookings/${b.booking_id}#rate`}>Rate</Link> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2 className="h2 mb-3">My requests</h2>
          {reqs.length === 0 ? <Empty>You have not posted any requests yet.</Empty> : (
            <div className="space-y-2">
              {reqs.slice(0, 15).map((r) => (
                <Link key={r.request_id} href={r.booking_id && r.status !== 'open' ? `/bookings/${r.booking_id}` : `/customer/requests/${r.request_id}`}
                  className="flex items-start justify-between gap-3 rounded-lg border border-line bg-white px-4 py-3 hover:border-brand">
                  <div>
                    <div className="text-sm">{r.description}</div>
                    <div className="text-xs text-muted">{fmtDateTime(r.created_at)}</div>
                  </div>
                  <Pill s={r.status} />
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
