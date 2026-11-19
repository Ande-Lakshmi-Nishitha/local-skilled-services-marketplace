import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { cancelBooking, payInvoice, raiseDispute, rateBooking, setOutcome } from '../../actions';
import { Flash, PageHeader, Pill } from '@/components/ui';
import { fmtDateTime, fmtSlot, inr, relHours } from '@/lib/format';
import { getSession } from '@/lib/session';
import { bookingDisputes, bookingPayments, getBooking, refundPreview } from '@/lib/services/bookings';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function BookingPage({ params, searchParams }: Props) {
  const s = await getSession();
  if (!s) redirect('/login');
  const { id } = await params;
  const sp = await searchParams;
  const b = await getBooking(Number(id), s.role, s.id).catch(() => null);
  if (!b) notFound();

  const [disputes, payments] = await Promise.all([bookingDisputes(b.booking_id), b.invoice_id ? bookingPayments(b.invoice_id) : Promise.resolve([])]);
  const started = new Date(b.start_time).getTime() <= Date.now();
  const isCustomer = s.role === 'customer';
  const isWorker = s.role === 'worker';
  const canCancel = (isCustomer || isWorker) && b.status === 'confirmed' && !started;
  const refund = refundPreview(b, s.role);
  const home = isCustomer ? '/customer' : isWorker ? '/worker' : '/admin';

  return (
    <div className="max-w-4xl">
      <PageHeader title={b.description} back={{ href: home, label: 'Back' }}
        sub={<>Booking #{b.booking_id} · <Pill s={b.status} /> · booked {fmtDateTime(b.created_at)}</>} />
      <Flash sp={sp} />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card">
          <h2 className="h2 mb-3">Appointment</h2>
          <dl className="space-y-2 text-sm">
            <div><dt className="label">When</dt><dd>{fmtSlot(b.start_time, b.end_time)} <span className="text-muted">({relHours(b.start_time)})</span></dd></div>
            <div><dt className="label">Worker</dt><dd><Link className="link" href={`/workers/${b.worker_id}`}>{b.worker_name}</Link>{b.status === 'confirmed' && b.worker_phone ? ` · ${b.worker_phone}` : ''}</dd></div>
            <div><dt className="label">Customer</dt><dd>{b.customer_name}{isWorker && b.status === 'confirmed' && b.customer_phone ? ` · ${b.customer_phone}` : ''}</dd></div>
            {b.cancelled_at && <div><dt className="label">Cancelled</dt><dd>{fmtDateTime(b.cancelled_at)} by {b.cancelled_by}</dd></div>}
          </dl>

          {isWorker && b.status === 'confirmed' && (
            <div className="mt-5 border-t border-line pt-4">
              {started ? (
                <div className="flex flex-wrap gap-2">
                  <form action={setOutcome}><input type="hidden" name="booking_id" value={b.booking_id} /><input type="hidden" name="outcome" value="completed" /><button className="btn-primary">Mark job completed</button></form>
                  <form action={setOutcome}><input type="hidden" name="booking_id" value={b.booking_id} /><input type="hidden" name="outcome" value="no_show" /><button className="btn-danger">Customer did not show up</button></form>
                </div>
              ) : <p className="muted">You can mark the outcome once the slot has started.</p>}
            </div>
          )}

          {canCancel && (
            <details className="mt-5 border-t border-line pt-4">
              <summary className="cursor-pointer text-sm font-medium text-bad">Cancel this booking</summary>
              <p className="muted mt-2">Cancelling now gives a <b>{refund.label}</b>{isWorker ? ' to the customer, and the slot will be blocked' : ''}.</p>
              <form action={cancelBooking} className="mt-3">
                <input type="hidden" name="booking_id" value={b.booking_id} />
                <input type="hidden" name="role" value={s.role} />
                <button className="btn-danger">Yes, cancel</button>
              </form>
            </details>
          )}
        </section>

        <section className="card">
          <h2 className="h2 mb-3">Invoice</h2>
          {b.invoice_id === null ? <p className="muted">No invoice.</p> : (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-2xl font-semibold">{inr(b.amount ?? 0)}</span>
                <Pill s={b.invoice_status ?? ''} />
              </div>
              <p className="muted mt-1">Invoice #{b.invoice_id} · hourly rate × slot length, issued by the booking procedure.</p>
              {payments.length > 0 && (
                <table className="table mt-4">
                  <thead><tr><th>Payment</th><th>Method</th><th>Status</th><th>Refunded</th></tr></thead>
                  <tbody>{payments.map((p) => (
                    <tr key={p.payment_id}><td>{inr(p.amount)}<div className="text-xs text-muted">{p.paid_at ? fmtDateTime(p.paid_at) : ''}</div></td><td className="uppercase">{p.method}</td><td><Pill s={p.status} /></td><td>{inr(p.refund_amount)}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {isCustomer && b.invoice_status === 'issued' && b.status !== 'cancelled' && (
                <form action={payInvoice} className="mt-4 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="booking_id" value={b.booking_id} />
                  <input type="hidden" name="invoice_id" value={b.invoice_id} />
                  <div>
                    <label className="label" htmlFor="method">Pay with</label>
                    <select id="method" name="method" className="input w-40" defaultValue="upi">
                      <option value="upi">UPI</option><option value="card">Card</option><option value="netbanking">Net banking</option><option value="cash">Cash</option>
                    </select>
                  </div>
                  <button className="btn-primary">Pay {inr(b.amount ?? 0)}</button>
                  <span className="muted w-full text-xs">Simulated gateway - no real money moves.</span>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {isCustomer && b.status === 'completed' && (
        <section id="rate" className="card mt-4">
          <h2 className="h2 mb-3">Your rating</h2>
          {b.rating_score ? (
            <p className="text-sm"><span className="text-[#c98a00]">{'★'.repeat(b.rating_score)}{'☆'.repeat(5 - b.rating_score)}</span> {b.rating_comment}</p>
          ) : (
            <form action={rateBooking} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="booking_id" value={b.booking_id} />
              <div>
                <label className="label" htmlFor="score">Stars</label>
                <select id="score" name="score" className="input w-28" defaultValue="5">
                  {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}
                </select>
              </div>
              <div className="min-w-64 flex-1">
                <label className="label" htmlFor="comment">Comment (optional)</label>
                <input id="comment" name="comment" maxLength={1000} className="input" placeholder="How did it go?" />
              </div>
              <button className="btn-primary">Submit rating</button>
            </form>
          )}
        </section>
      )}

      <section className="card mt-4">
        <h2 className="h2 mb-3">Disputes</h2>
        {disputes.length === 0 ? <p className="muted">None.</p> : (
          <ul className="space-y-2">
            {disputes.map((d) => (
              <li key={d.dispute_id} className="rounded-lg border border-line px-3 py-2 text-sm">
                <div className="flex items-center justify-between"><span>Raised by <b>{d.raised_by_role}</b> · {fmtDateTime(d.created_at)}</span><Pill s={d.status} /></div>
                <p className="mt-1">{d.reason}</p>
                {d.resolution_note && <p className="mt-1 text-muted">Admin: {d.resolution_note}</p>}
              </li>
            ))}
          </ul>
        )}
        {(isCustomer || isWorker) && b.status !== 'confirmed' && b.open_disputes === 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-medium">Report a problem</summary>
            <form action={raiseDispute} className="mt-3 space-y-2">
              <input type="hidden" name="booking_id" value={b.booking_id} />
              <input type="hidden" name="role" value={s.role} />
              <textarea name="reason" required minLength={5} maxLength={1000} rows={3} className="input" placeholder="What went wrong?" />
              <button className="btn-ghost">Send to admin</button>
            </form>
          </details>
        )}
      </section>
    </div>
  );
}
