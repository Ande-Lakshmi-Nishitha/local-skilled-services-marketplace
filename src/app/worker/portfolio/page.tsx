import Link from 'next/link';
import { deletePhoto, savePortfolio, uploadPhoto } from '../../actions';
import { Flash, PageHeader } from '@/components/ui';
import { requireRole } from '@/lib/session';
import { attributesToLines, certificationsToLines, getWorkerProfile } from '@/lib/services/workers';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// Suggested attribute keys per trade. Purely a hint: MongoDB accepts any keys.
const TEMPLATES: Record<string, string> = {
  Electrician: 'license_no: KEL-EX-00000\nlicense_valid_till: 2028-03-31\nvoltage_certified: LT, HT\nemergency_service: true',
  Plumber: 'emergency_service: true\ncarries_spares: true\nservice_radius_km: 8',
  'Appliance Repair': 'brands_serviced: LG, Samsung, Whirlpool\nspare_parts_warranty_days: 90',
  Tutor: 'subjects: Mathematics, Physics\ngrade_levels: 9, 10, 11, 12\nboard: CBSE\nmode: home, online\nfree_demo_class: true',
  'Home Cleaning': 'languages: Kannada, Hindi\npolice_verification: true\nequipment: steam cleaner',
  Carpenter: 'wood_types: teak, plywood\non_site_only: true\ntools_owned: hammer drill, laser level',
  Painter: 'paint_brands: Asian Paints, Berger\nfinishes: matt, satin\nsq_ft_rate: 18',
  'Pest Control': 'chemicals_used: fipronil gel\nchild_safe: true\nwarranty_months: 3',
};

export default async function Portfolio({ searchParams }: Props) {
  const s = await requireRole('worker');
  const sp = await searchParams;
  const w = await getWorkerProfile(s.id);
  if (!w) return <p>Worker not found. <Link className="link" href="/login">Sign in again</Link></p>;
  const p = w.portfolio;
  const template = TEMPLATES[w.categories[0]?.name ?? ''] ?? 'key: value';

  return (
    <div>
      <PageHeader title="My portfolio" sub="Stored as one MongoDB document. Every trade can have different fields - add whatever describes your work." />
      <Flash sp={sp} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <form action={savePortfolio} className="card space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div><label className="label" htmlFor="trade">Trade</label><input id="trade" name="trade" required minLength={2} defaultValue={p?.trade ?? w.categories[0]?.name} className="input" /></div>
              <div><label className="label" htmlFor="skills">Skills (comma separated)</label><input id="skills" name="skills" defaultValue={p?.trade_attributes.skills?.join(', ')} className="input" /></div>
            </div>
            <div>
              <label className="label" htmlFor="attributes">Trade-specific details (one <code>key: value</code> per line, commas make a list)</label>
              <textarea id="attributes" name="attributes" rows={7} className="input font-mono text-xs" defaultValue={p ? attributesToLines(p.trade_attributes) : ''} placeholder={template} />
              <p className="muted mt-1 text-xs">Example for {w.categories[0]?.name ?? 'your trade'}: <code className="whitespace-pre-wrap">{template.replace(/\n/g, ' · ')}</code></p>
            </div>
            <div>
              <label className="label" htmlFor="certifications">Certifications (one per line: name | issuer | number | year)</label>
              <textarea id="certifications" name="certifications" rows={3} className="input font-mono text-xs" defaultValue={p ? certificationsToLines(p.certifications) : ''} placeholder="ITI Electrician | Govt ITI | | 2015" />
            </div>
            <button className="btn-primary">Save portfolio</button>
          </form>

          <section className="card">
            <h2 className="h2 mb-3">Photos of your work</h2>
            {p && p.photos.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {p.photos.map((ph) => (
                  <figure key={ph.url} className="space-y-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ph.url} alt={ph.caption ?? ''} className="aspect-[4/3] w-full rounded-lg object-cover" />
                    <figcaption className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span>{ph.caption}</span>
                      <form action={deletePhoto}><input type="hidden" name="url" value={ph.url} /><button className="text-bad hover:underline">remove</button></form>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
            <form action={uploadPhoto} className="flex flex-wrap items-end gap-3">
              <div><label className="label" htmlFor="photo">Photo (JPG, PNG, WebP, max 5 MB)</label><input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp" required className="text-sm" /></div>
              <div className="min-w-48 flex-1"><label className="label" htmlFor="caption">Caption</label><input id="caption" name="caption" maxLength={200} className="input" /></div>
              <button className="btn-ghost">Upload</button>
            </form>
          </section>
        </div>

        <aside className="card h-fit">
          <h2 className="text-sm font-semibold">Your document in MongoDB</h2>
          <p className="muted mb-2 text-xs">Collection <code>worker_portfolio</code>, matched to PostgreSQL by <code>worker_id</code>.</p>
          <pre className="max-h-[32rem] overflow-auto rounded-lg bg-[#10201c] p-3 text-[11px] leading-relaxed text-[#d7efe8]">{p ? JSON.stringify(p, null, 2) : '(no document yet)'}</pre>
        </aside>
      </div>
    </div>
  );
}
