import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from './actions';
import { getSession } from '@/lib/session';
import './globals.css';

// Every page reads the session cookie and the database: always render per request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SkillMarket - local skilled services',
  description: 'Describe your problem in plain words; get matched to verified local workers and book a slot.',
};

const NAV: Record<string, { href: string; label: string }[]> = {
  customer: [{ href: '/customer', label: 'My requests' }, { href: '/leaderboard', label: 'Top workers' }],
  worker: [{ href: '/worker', label: 'Jobs' }, { href: '/worker/availability', label: 'Availability' }, { href: '/worker/profile', label: 'Profile' }, { href: '/worker/portfolio', label: 'Portfolio' }],
  admin: [{ href: '/admin', label: 'Dashboard' }, { href: '/leaderboard', label: 'Leaderboard' }],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const s = await getSession();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-brand text-sm text-white">S</span>
              SkillMarket
            </Link>
            <nav className="flex flex-wrap gap-4 text-sm">
              {(s ? NAV[s.role] : [{ href: '/leaderboard', label: 'Top workers' }]).map((n) => (
                <Link key={n.href} href={n.href} className="text-muted hover:text-ink">{n.label}</Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-3 text-sm">
              {s ? (
                <>
                  <span className="text-muted"><span className="font-medium text-ink">{s.name}</span> · {s.role}</span>
                  <form action={signOut}><button className="btn-ghost btn-sm">Switch user</button></form>
                </>
              ) : (
                <Link href="/login" className="btn-primary btn-sm">Sign in</Link>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted">
          DBMS project demo · PostgreSQL (transactions) + pgvector (semantic search) + MongoDB (portfolios) · payments are simulated
        </footer>
      </body>
    </html>
  );
}
