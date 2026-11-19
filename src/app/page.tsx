import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, homeFor } from '@/lib/session';

export default async function Home() {
  const s = await getSession();
  if (s) redirect(homeFor(s.role));
  return (
    <div className="space-y-10">
      <section className="max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight">Say what&apos;s wrong. We&apos;ll find who can fix it.</h1>
        <p className="mt-4 text-lg text-muted">
          Type your problem the way you&apos;d tell a friend - &ldquo;fan not spinning&rdquo;, &ldquo;AC rattling and not cooling&rdquo;.
          SkillMarket understands the meaning, finds verified local workers who are free, ranks them by fit and reputation,
          and books the slot without any chance of double booking.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/login?need=customer" className="btn-primary">I need help</Link>
          <Link href="/worker/register" className="btn-ghost">I&apos;m a worker</Link>
          <Link href="/login" className="btn-ghost">Sign in as a demo user</Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          ['PostgreSQL', 'Bookings, invoices, payments and ratings. One stored procedure reserves the slot, books it and issues the invoice in a single transaction.'],
          ['pgvector', 'Requests and worker skills are embedded as 384-number vectors. An HNSW index finds the closest meaning, so "fan not spinning" reaches an electrician.'],
          ['MongoDB', 'Portfolios differ by trade: licences for electricians, subjects for tutors, references for maids. One flexible document per worker.'],
        ].map(([t, d]) => (
          <div key={t} className="card">
            <div className="text-sm font-semibold text-brand">{t}</div>
            <p className="mt-2 text-sm text-muted">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
