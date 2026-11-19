import Link from 'next/link';
import { Empty, Flash, PageHeader, Pill, Stars } from '@/components/ui';
import { fmtDateTime, fmtSlot, inr, relHours } from '@/lib/format';
import { requireRole } from '@/lib/session';
import { listBookings } from '@/lib/services/bookings';
import { getWorkerProfile, matchingOpenRequests } from '@/lib/services/workers';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function WorkerHome({ searchParams }: Props) {
  const s = await requireRole('worker');
  const sp = await searchParams;
  const [w, jobs, leads] = await Promise.all([getWorkerProfile(s.id), listBookings('worker', s.id), matchingOpenRequests(s.id).catch(() => [])]);
  if (!w) return <p>Worker not found. <Link className="link" href="/login">Sign in again</Link></p>;
  const active = jobs.filter((j) => j.status === 'confirmed').sort((a, b) => +new Date(a.start_time) - +new Date(b.start_time));
  const past = jobs.filter((j) => j.status !== 'confirmed').slice(0, 10);

  return (
    <div>
      <PageHeader title={`Hello ${w.name.split(' ')[0]}`} sub={<><Stars avg={w.avg_rating} count={w.rating_count} /> · {w.completed_jobs} jobs completed</>}>
        <div className="flex gap-2">
          <Link href="/worker/availability" className="btn-ghost">Manage availability</Link>
          <Link href="/worker/portfolio" className="btn-ghost">Edit portfolio</Link>
        </div>
      </PageHeader>
      <Flash sp={sp} />
      {w.verification_status !== 'verified' && (
        <div className="mb-6 rounded-lg border border-[#f5d7a8] bg-warn-soft px-4 py-3 text-sm text-warn">
          Your profile is <b>{w.verification_status}</b>. {w.verification_status === 'pending' ? 'An admin has to verify it before customers can find and book you.' : 'Contact the platform admin.'}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="h2 mb-3">Upcoming and in-progress jobs</h2>
          {active.length === 0 ? <Empty>No upcoming jobs.</Empty> : (
            <div className="space-y-3">
              {active.map((j) => (
                <Link key={j.booking_id} href={`/bookings/${j.booking_id}`} className="card block hover:border-brand">
                  <div className="flex items-start justify-between gap-2">
                    <div><div className="font-medium">{j.description}</div><div className="muted">{j.customer_name}</div></div>
                    {new Date(j.start_time) <= new Date() ? <span className="whitespace-nowrap rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">in progress</span> : <Pill s="confirmed" />}
                  </div>
                  <div className="mt-2 text-sm">{fmtSlot(j.start_time, j.end_time)} <span className="text-muted">({relHours(j.start_time)})</span> · {inr(j.amount ?? 0)} <Pill s={j.invoice_status ?? ''} /></div>
                </Link>
              ))}
            </div>
          )}
          <h2 className="h2 mb-3 mt-8">Past jobs</h2>
          {past.length === 0 ? <Empty>None yet.</Empty> : (
            <table className="table">
              <thead><tr><th>Job</th><th>When</th><th>Status</th><th>Rating</th></tr></thead>
              <tbody>{past.map((j) => (
                <tr key={j.booking_id}>
                  <td><Link className="link" href={`/bookings/${j.booking_id}`}>{j.description}</Link></td>
                  <td className="whitespace-nowrap">{fmtDateTime(j.start_time)}</td>
                  <td><Pill s={j.status} /></td>
                  <td>{j.rating_score ? '★'.repeat(j.rating_score) : '–'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>

        <section>
          <h2 className="h2 mb-1">Open requests that match your skills</h2>
          <p className="muted mb-3">Found by reverse semantic matching: your skill and bio vectors against customers&apos; request vectors. Customers choose whom to book.</p>
          {w.verification_status !== 'verified' ? <Empty>Available once you are verified.</Empty>
            : leads.length === 0 ? <Empty>No open requests close to your skills right now.</Empty> : (
            <ul className="space-y-2">
              {leads.map((l) => (
                <li key={l.request_id} className="rounded-lg border border-line bg-white px-4 py-3">
                  <div className="text-sm">{l.description}</div>
                  <div className="mt-1 text-xs text-muted">{l.customer_locality ?? 'Unknown area'} · posted {fmtDateTime(l.created_at)} · match {(Number(l.similarity) * 100).toFixed(0)}%</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
