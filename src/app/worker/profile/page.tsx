import Link from 'next/link';
import { updateProfile } from '../../actions';
import { Flash, PageHeader, Pill } from '@/components/ui';
import { WorkerForm } from '@/components/worker-form';
import { requireRole } from '@/lib/session';
import { listCategories } from '@/lib/services/catalogue';
import { getWorkerProfile } from '@/lib/services/workers';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Profile({ searchParams }: Props) {
  const s = await requireRole('worker');
  const sp = await searchParams;
  const [w, cats] = await Promise.all([getWorkerProfile(s.id), listCategories()]);
  if (!w) return <p>Worker not found. <Link className="link" href="/login">Sign in again</Link></p>;
  return (
    <div className="max-w-3xl">
      <PageHeader title="My profile" sub={<>Status <Pill s={w.verification_status} /> · <Link className="link" href={`/workers/${w.worker_id}`}>view public profile</Link></>} />
      <Flash sp={sp} />
      <WorkerForm action={updateProfile} categories={cats} emailLocked submit="Save profile"
        v={{ name: w.name, email: w.email, phone: w.phone, locality: w.locality, bio: w.bio, hourly_rate: w.hourly_rate,
             category_ids: w.categories.map((c) => c.category_id), trade: w.portfolio?.trade, skills: w.portfolio?.trade_attributes.skills }} />
    </div>
  );
}
