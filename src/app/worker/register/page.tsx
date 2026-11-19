import { registerWorker } from '../../actions';
import { Flash, PageHeader } from '@/components/ui';
import { WorkerForm } from '@/components/worker-form';
import { listCategories } from '@/lib/services/catalogue';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Register({ searchParams }: Props) {
  const sp = await searchParams;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Join as a worker" sub="Your profile is saved in PostgreSQL, your portfolio in MongoDB, and your skills are embedded for semantic search. An admin verifies you before customers can see you." />
      <Flash sp={sp} />
      <WorkerForm action={registerWorker} categories={await listCategories()} submit="Create my profile" />
    </div>
  );
}
