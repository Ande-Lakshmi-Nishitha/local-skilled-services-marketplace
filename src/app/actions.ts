'use server';
// Every form in the app posts to one of these server actions. Each one:
//   1. checks the signed-in role (requireRole)       2. validates input
//   3. calls ONE service function (most call one stored procedure)
//   4. redirects back with a success / error message
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { redirect } from 'next/navigation';
import { int, run, safeBack, str } from '@/lib/action';
import { one } from '@/lib/db';
import { invalid } from '@/lib/errors';
import { clearSession, homeFor, requireRole, setSession, type Role } from '@/lib/session';
import * as bookings from '@/lib/services/bookings';
import * as admin from '@/lib/services/admin';
import * as requests from '@/lib/services/requests';
import * as slots from '@/lib/services/slots';
import * as workers from '@/lib/services/workers';

// ------------------------------------------------------------------ sign in / out
export async function signIn(fd: FormData) {
  const role = str(fd.get('role')) as Role;
  const id = int(fd.get('id'));
  const table = { customer: ['customer', 'customer_id'], worker: ['worker', 'worker_id'], admin: ['admin', 'admin_id'] }[role];
  if (!table || !Number.isInteger(id)) redirect('/login?err=Pick+a+user');
  const row = await one<{ name: string }>(`SELECT name FROM ${table[0]} WHERE ${table[1]} = $1`, [id]);
  if (!row) redirect('/login?err=That+user+no+longer+exists.+Was+the+database+reset%3F');
  await setSession({ role, id, name: row.name });
  redirect(homeFor(role));
}

export async function signOut() {
  await clearSession();
  redirect('/');
}

// ------------------------------------------------------------------ customer
export async function postRequest(fd: FormData) {
  const s = await requireRole('customer');
  await run('/customer', async () => {
    const id = await requests.createRequest(s.id, str(fd.get('description')));
    return { to: `/customer/requests/${id}` };
  });
}

export async function withdrawRequest(fd: FormData) {
  const s = await requireRole('customer');
  const id = int(fd.get('request_id'));
  await run(`/customer/requests/${id}`, async () => {
    await requests.withdrawRequest(id, s.id);
    return { to: '/customer', ok: 'Request withdrawn.' };
  });
}

export async function bookSlot(fd: FormData) {
  const s = await requireRole('customer');
  const back = safeBack(fd.get('back'), '/customer');
  await run(back, async () => {
    const id = await bookings.createBooking(s.id, int(fd.get('request_id')), int(fd.get('worker_id')), int(fd.get('slot_id')));
    return { to: `/bookings/${id}`, ok: 'Booked! The slot is reserved for you and your invoice is ready.' };
  });
}

export async function payInvoice(fd: FormData) {
  const s = await requireRole('customer');
  const b = int(fd.get('booking_id'));
  await run(`/bookings/${b}`, async () => {
    await bookings.payInvoice(int(fd.get('invoice_id')), s.id, str(fd.get('method')));
    return { ok: 'Payment successful (simulated gateway).' };
  });
}

export async function cancelBooking(fd: FormData) {
  const role = str(fd.get('role')) === 'worker' ? 'worker' : 'customer';
  const s = await requireRole(role);
  const b = int(fd.get('booking_id'));
  await run(`/bookings/${b}`, async () => {
    const r = await bookings.cancelBooking(b, role, s.id);
    return { ok: `Booking cancelled. Refund: ₹${r.refund} (${r.policy} refund policy).` };
  });
}

export async function rateBooking(fd: FormData) {
  const s = await requireRole('customer');
  const b = int(fd.get('booking_id'));
  await run(`/bookings/${b}`, async () => {
    await bookings.rateBooking(b, s.id, int(fd.get('score')), str(fd.get('comment')));
    return { ok: 'Thanks! The worker’s rating was updated by a database trigger.' };
  });
}

export async function raiseDispute(fd: FormData) {
  const role = str(fd.get('role')) === 'worker' ? 'worker' : 'customer';
  const s = await requireRole(role);
  const b = int(fd.get('booking_id'));
  await run(`/bookings/${b}`, async () => {
    await bookings.raiseDispute(b, role, s.id, str(fd.get('reason')));
    return { ok: 'Dispute raised. An admin will review it.' };
  });
}

// ------------------------------------------------------------------ worker
function workerForm(fd: FormData) {
  return workers.parseWorkerInput({
    name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), locality: fd.get('locality'), bio: fd.get('bio'),
    hourly_rate: fd.get('hourly_rate'), category_ids: fd.getAll('category_ids'), trade: fd.get('trade'), skills: fd.get('skills'),
  });
}

export async function registerWorker(fd: FormData) {
  let id = 0;
  let name = '';
  await run('/worker/register', async () => {
    const input = workerForm(fd);
    const r = await workers.registerWorker(input);
    id = r.worker_id;
    name = input.name;
    await setSession({ role: 'worker', id, name });
    return { to: '/worker', ok: r.synced ? 'Welcome! Your profile is waiting for admin verification.' : 'Registered, but the portfolio/embeddings could not be saved. Run npm run db:reconcile.' };
  });
}

export async function updateProfile(fd: FormData) {
  const s = await requireRole('worker');
  await run('/worker/profile', async () => {
    const current = await one<{ email: string }>('SELECT email FROM worker WHERE worker_id = $1', [s.id]);
    fd.set('email', current?.email ?? '');
    const ok = await workers.updateWorker(s.id, workerForm(fd));
    return { ok: ok ? 'Profile saved. Your search embeddings were refreshed.' : 'Saved, but MongoDB/embeddings could not be updated (run npm run db:reconcile).' };
  });
}

export async function savePortfolio(fd: FormData) {
  const s = await requireRole('worker');
  await run('/worker/portfolio', async () => {
    const trade = str(fd.get('trade')).trim();
    if (trade.length < 2) throw invalid('Trade must be at least 2 characters');
    const ok = await workers.savePortfolio(s.id, {
      trade, skills: workers.parseSkills(str(fd.get('skills'))),
      attributes: workers.parseAttributeLines(str(fd.get('attributes'))),
      certifications: workers.parseCertifications(str(fd.get('certifications'))),
    });
    return { ok: ok ? 'Portfolio saved to MongoDB and your skill embedding was refreshed.' : 'Saved, but embeddings could not be refreshed (run npm run db:reconcile).' };
  });
}

const UPLOAD_DIR = () => process.env.UPLOAD_DIR || join(/*turbopackIgnore: true*/ process.cwd(), 'uploads');

/** Detect the real file type from its first bytes (never trust the file name or browser type). */
function sniff(b: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export async function uploadPhoto(fd: FormData) {
  const s = await requireRole('worker');
  await run('/worker/portfolio', async () => {
    const file = fd.get('photo');
    if (!(file instanceof File) || file.size === 0) throw invalid('Choose a photo');
    if (file.size > 5 * 1024 * 1024) throw invalid('Photos must be 5 MB or smaller');
    const buf = Buffer.from(await file.arrayBuffer());
    const ext = sniff(buf);
    if (!ext) throw invalid('Only JPG, PNG or WebP images');
    const dir = join(/*turbopackIgnore: true*/ UPLOAD_DIR(), String(s.id));
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}.${ext}`;
    await writeFile(join(/*turbopackIgnore: true*/ dir, name), buf);
    await workers.addPhoto(s.id, `/uploads/${s.id}/${name}`, str(fd.get('caption')).trim() || undefined);
    return { ok: 'Photo added.' };
  });
}

export async function deletePhoto(fd: FormData) {
  const s = await requireRole('worker');
  await run('/worker/portfolio', async () => {
    const url = str(fd.get('url'));
    const m = url.match(/^\/uploads\/(\d+)\/([a-f0-9-]+\.(?:jpg|png|webp))$/);
    await workers.removePhoto(s.id, url);
    if (m && Number(m[1]) === s.id) await unlink(join(/*turbopackIgnore: true*/ UPLOAD_DIR(), m[1], m[2])).catch(() => undefined);
    return { ok: 'Photo removed.' };
  });
}

export async function addSlots(fd: FormData) {
  const s = await requireRole('worker');
  await run('/worker/availability', async () => {
    const n = await slots.addSlots(s.id, str(fd.get('date')), str(fd.get('time')), Number(fd.get('hours')), int(fd.get('days')));
    return { ok: `${n} slot${n === 1 ? '' : 's'} added.` };
  });
}

export async function changeSlot(fd: FormData) {
  const s = await requireRole('worker');
  const id = int(fd.get('slot_id'));
  const op = str(fd.get('op'));
  await run('/worker/availability', async () => {
    if (op === 'delete') await slots.deleteSlot(s.id, id);
    else await slots.setSlotStatus(s.id, id, op === 'open' ? 'open' : 'blocked');
  });
}

export async function setOutcome(fd: FormData) {
  const s = await requireRole('worker');
  const b = int(fd.get('booking_id'));
  const outcome = str(fd.get('outcome')) === 'no_show' ? 'no_show' : 'completed';
  await run(`/bookings/${b}`, async () => {
    await bookings.setOutcome(b, s.id, outcome);
    return { ok: outcome === 'completed' ? 'Marked as completed. The customer can now rate the job.' : 'Marked as no-show. A dispute was opened automatically (trigger) for an admin to review.' };
  });
}

// ------------------------------------------------------------------ admin
export async function reviewWorker(fd: FormData) {
  const s = await requireRole('admin');
  await run('/admin', async () => {
    const decision = str(fd.get('decision'));
    await admin.reviewWorker(int(fd.get('worker_id')), s.id, decision);
    return { ok: decision === 'verified' ? 'Worker verified: they now appear in search results.' : 'Worker rejected.' };
  });
}

export async function resolveDispute(fd: FormData) {
  const s = await requireRole('admin');
  await run('/admin#disputes', async () => {
    await admin.resolveDispute(int(fd.get('dispute_id')), s.id, str(fd.get('status')), str(fd.get('note')), Number(fd.get('refund') || 0));
    return { ok: 'Dispute closed.' };
  });
}
