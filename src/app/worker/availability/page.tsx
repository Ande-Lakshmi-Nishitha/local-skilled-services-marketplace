import Link from 'next/link';
import { addSlots, changeSlot } from '../../actions';
import { Empty, Flash, PageHeader, Pill } from '@/components/ui';
import { fmtDate, fmtTime, TZ } from '@/lib/format';
import { requireRole } from '@/lib/session';
import { workerSlots } from '@/lib/services/slots';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Availability({ searchParams }: Props) {
  const s = await requireRole('worker');
  const sp = await searchParams;
  const slots = await workerSlots(s.id);
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: TZ });

  const byDay = new Map<string, typeof slots>();
  for (const sl of slots) {
    const k = fmtDate(sl.start_time);
    byDay.set(k, [...(byDay.get(k) ?? []), sl]);
  }

  return (
    <div>
      <PageHeader title="Availability" sub="Customers can only book open future slots. Overlapping slots are rejected by the database (exclusion constraint); booked slots are protected by a trigger." />
      <Flash sp={sp} />
      <form action={addSlots} className="card mb-6 flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor="date">First day</label><input id="date" name="date" type="date" required defaultValue={tomorrow} className="input" /></div>
        <div><label className="label" htmlFor="time">Start (India time)</label><input id="time" name="time" type="time" required defaultValue="09:00" className="input" /></div>
        <div><label className="label" htmlFor="hours">Length (h)</label><input id="hours" name="hours" type="number" min={0.5} max={8} step={0.5} defaultValue={2} className="input w-24" /></div>
        <div><label className="label" htmlFor="days">Repeat for (days)</label><input id="days" name="days" type="number" min={1} max={30} defaultValue={1} className="input w-24" /></div>
        <button className="btn-primary">Add slots</button>
      </form>

      {slots.length === 0 ? <Empty>No slots yet. Add some above so customers can book you.</Empty> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[...byDay.entries()].map(([day, list]) => (
            <section key={day} className="card">
              <h2 className="mb-2 text-sm font-semibold">{day}</h2>
              <ul className="space-y-2">
                {list.map((sl) => (
                  <li key={sl.slot_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="tabular-nums">{fmtTime(sl.start_time)} – {fmtTime(sl.end_time)}</span>
                    <span className="flex items-center gap-1.5">
                      <Pill s={sl.status} />
                      {sl.status === 'reserved' && sl.booking_id ? (
                        <Link className="link text-xs" href={`/bookings/${sl.booking_id}`}>{sl.customer_name}</Link>
                      ) : new Date(sl.start_time) > new Date() ? (
                        <>
                          <form action={changeSlot}><input type="hidden" name="slot_id" value={sl.slot_id} /><input type="hidden" name="op" value={sl.status === 'open' ? 'blocked' : 'open'} />
                            <button className="btn-ghost btn-sm">{sl.status === 'open' ? 'Block' : 'Open'}</button></form>
                          <form action={changeSlot}><input type="hidden" name="slot_id" value={sl.slot_id} /><input type="hidden" name="op" value="delete" />
                            <button className="btn-danger btn-sm" aria-label="Delete slot">✕</button></form>
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
