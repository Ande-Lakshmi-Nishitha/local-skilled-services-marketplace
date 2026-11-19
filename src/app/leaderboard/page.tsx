import Link from 'next/link';
import { Empty, PageHeader, Stars } from '@/components/ui';
import { leaderboard } from '@/lib/services/admin';
import { listCategories } from '@/lib/services/catalogue';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Leaderboard({ searchParams }: Props) {
  const sp = await searchParams;
  const cat = typeof sp.category === 'string' && sp.category ? Number(sp.category) : null;
  const [cats, rows] = await Promise.all([listCategories(), leaderboard(cat)]);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) groups.set(r.category_name, [...(groups.get(r.category_name) ?? []), r]);

  return (
    <div>
      <PageHeader title="Top workers by category"
        sub="From the view v_worker_leaderboard: verified workers ranked with RANK() OVER (PARTITION BY category) on a Bayesian rating, so a single 5★ review does not top the chart." />
      <div className="mb-5 flex flex-wrap gap-1.5">
        <Link href="/leaderboard" className={`chip ${cat === null ? 'border-brand bg-brand-soft' : ''}`}>All</Link>
        {cats.map((c) => <Link key={c.category_id} href={`/leaderboard?category=${c.category_id}`} className={`chip ${cat === c.category_id ? 'border-brand bg-brand-soft' : ''}`}>{c.name}</Link>)}
      </div>
      {rows.length === 0 ? <Empty>No verified workers yet.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {[...groups.entries()].map(([name, list]) => (
            <section key={name} className="card">
              <h2 className="h2 mb-2">{name}</h2>
              <table className="table">
                <thead><tr><th>#</th><th>Worker</th><th>Rating</th><th>Trust</th><th>Jobs</th></tr></thead>
                <tbody>{list.map((r) => (
                  <tr key={r.worker_id}>
                    <td className="font-semibold">{r.rank_in_category}</td>
                    <td><Link className="link" href={`/workers/${r.worker_id}`}>{r.name}</Link><div className="text-xs text-muted">{r.locality}</div></td>
                    <td><Stars avg={r.avg_rating === null ? null : Number(r.avg_rating)} count={r.rating_count} /></td>
                    <td className="tabular-nums">{Number(r.bayesian_score).toFixed(2)}</td>
                    <td className="tabular-nums">{r.completed_jobs}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
