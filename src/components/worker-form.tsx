import type { Category } from '@/lib/services/catalogue';

export interface WorkerFormValues {
  name?: string; email?: string; phone?: string | null; locality?: string; bio?: string | null; hourly_rate?: number;
  category_ids?: number[]; trade?: string; skills?: string[];
}

/** Used by registration and by "edit profile". Email is fixed after registration. */
export function WorkerForm({ action, categories, v = {}, submit, emailLocked = false }: {
  action: (fd: FormData) => Promise<void>; categories: Category[]; v?: WorkerFormValues; submit: string; emailLocked?: boolean;
}) {
  return (
    <form action={action} className="card space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label className="label" htmlFor="name">Full name</label><input id="name" name="name" required minLength={2} maxLength={80} defaultValue={v.name} className="input" /></div>
        <div><label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required defaultValue={v.email} readOnly={emailLocked} className={`input ${emailLocked ? 'bg-paper text-muted' : ''}`} /></div>
        <div><label className="label" htmlFor="phone">Phone</label><input id="phone" name="phone" defaultValue={v.phone ?? ''} className="input" placeholder="+91-..." /></div>
        <div><label className="label" htmlFor="locality">Locality</label><input id="locality" name="locality" required minLength={2} maxLength={60} defaultValue={v.locality} className="input" placeholder="e.g. Koramangala" /></div>
        <div><label className="label" htmlFor="hourly_rate">Hourly rate (₹)</label><input id="hourly_rate" name="hourly_rate" type="number" min={1} step="1" required defaultValue={v.hourly_rate} className="input" /></div>
        <div><label className="label" htmlFor="trade">Trade (how you describe your work)</label><input id="trade" name="trade" required minLength={2} maxLength={60} defaultValue={v.trade} className="input" placeholder="e.g. AC technician" /></div>
      </div>
      <fieldset>
        <legend className="label">Service categories</legend>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <label key={c.category_id} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
              <input type="checkbox" name="category_ids" value={c.category_id} defaultChecked={v.category_ids?.includes(c.category_id)} /> {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label className="label" htmlFor="skills">Skills (comma separated)</label>
        <input id="skills" name="skills" defaultValue={v.skills?.join(', ')} className="input" placeholder="e.g. split AC repair, gas refilling, compressor replacement" />
      </div>
      <div>
        <label className="label" htmlFor="bio">About your work</label>
        <textarea id="bio" name="bio" rows={4} maxLength={1000} defaultValue={v.bio ?? ''} className="input"
          placeholder="Describe the problems you fix, in plain words. This text is what customers' requests are matched against." />
      </div>
      <button className="btn-primary">{submit}</button>
    </form>
  );
}
