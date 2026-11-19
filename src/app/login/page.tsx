import Link from 'next/link';
import type { ReactNode } from 'react';
import { signIn } from '../actions';
import { Flash, Pill } from '@/components/ui';
import { q } from '@/lib/db';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Login({ searchParams }: Props) {
  const sp = await searchParams;
  const customers = await q<{ customer_id: number; name: string; locality: string | null }>('SELECT customer_id, name, locality FROM customer ORDER BY customer_id');
  const workers = await q<{ worker_id: number; name: string; verification_status: string; categories: string }>(
    `SELECT w.worker_id, w.name, w.verification_status, string_agg(c.name, ', ' ORDER BY c.name) AS categories
     FROM worker w LEFT JOIN worker_category wc USING (worker_id) LEFT JOIN service_category c USING (category_id)
     GROUP BY w.worker_id ORDER BY w.worker_id`);
  const admins = await q<{ admin_id: number; name: string }>('SELECT admin_id, name FROM admin ORDER BY admin_id');
  const need = typeof sp.need === 'string' ? sp.need : null;

  const Btn = ({ role, id, children }: { role: string; id: number; children: ReactNode }) => (
    <form action={signIn}>
      <input type="hidden" name="role" value={role} />
      <input type="hidden" name="id" value={id} />
      <button className="w-full rounded-lg border border-line bg-white px-3 py-2 text-left text-sm hover:border-brand hover:bg-brand-soft">{children}</button>
    </form>
  );

  return (
    <div>
      <h1 className="h1">Sign in as a demo user</h1>
      <p className="muted mt-1 mb-6">No passwords in this demo: pick who you want to be. Roles are still enforced on the server for every page and action.</p>
      {need && <div className="mb-5 rounded-lg border border-line bg-white px-4 py-3 text-sm">Please sign in as a <b>{need}</b> to continue.</div>}
      <Flash sp={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card">
          <h2 className="h2 mb-3">Customers</h2>
          <div className="space-y-2">
            {customers.map((c) => <Btn key={c.customer_id} role="customer" id={c.customer_id}>{c.name} <span className="text-muted">· {c.locality}</span></Btn>)}
          </div>
          <p className="muted mt-4 text-xs">Aarav has a job in progress and an open request; Diya and Neha have paid upcoming bookings to try cancelling.</p>
        </section>
        <section className="card">
          <h2 className="h2 mb-3">Workers</h2>
          <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {workers.map((w) => (
              <Btn key={w.worker_id} role="worker" id={w.worker_id}>
                <span className="flex items-center justify-between gap-2"><span>{w.name} <span className="text-muted">· {w.categories}</span></span>
                  {w.verification_status !== 'verified' && <Pill s={w.verification_status} />}</span>
              </Btn>
            ))}
          </div>
          <Link href="/worker/register" className="link mt-4 inline-block text-sm">Register as a new worker →</Link>
        </section>
        <section className="card">
          <h2 className="h2 mb-3">Admin</h2>
          <div className="space-y-2">
            {admins.map((a) => <Btn key={a.admin_id} role="admin" id={a.admin_id}>{a.name}</Btn>)}
          </div>
          <p className="muted mt-4 text-xs">Verify new workers, resolve disputes, see platform analytics.</p>
        </section>
      </div>
    </div>
  );
}
