// Double-booking stress test: N customers try to book the SAME slot at the same instant.
// Expected every round: exactly 1 success, N-1 SLOT_TAKEN, and the database holds exactly one live booking
// and one invoice for that slot.
//
//   npm run test:concurrency                         20 clients x 10 rounds, straight to PostgreSQL
//   npm run test:concurrency -- --clients 50 --rounds 20
//   npm run test:concurrency -- --http http://localhost:3000    same test through the web API (app must be running)
//
// Test data is created per round and deleted afterwards.
import './_env';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const CLIENTS = Number(arg('clients', '20'));
const ROUNDS = Number(arg('rounds', '10'));
const HTTP = arg('http', '');
const URL_ = process.env.POSTGRES_URL!;

function cookieFor(customerId: number): string {
  const secret = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16 ? process.env.SESSION_SECRET : 'dev-only-insecure-secret-change-me';
  const payload = Buffer.from(JSON.stringify({ role: 'customer', id: customerId, name: `customer ${customerId}` })).toString('base64url');
  return `sm_session=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

async function main() {
  const admin = new Client({ connectionString: URL_ });
  await admin.connect();
  const { rows: [w] } = await admin.query(`SELECT worker_id, name FROM worker WHERE verification_status = 'verified' ORDER BY worker_id LIMIT 1`);
  const customers = (await admin.query('SELECT customer_id FROM customer ORDER BY customer_id')).rows.map((r) => r.customer_id as number);

  // one connection per simulated customer, opened before the race starts
  const conns: Client[] = [];
  if (!HTTP) for (let i = 0; i < CLIENTS; i++) { const c = new Client({ connectionString: URL_ }); await c.connect(); conns.push(c); }

  console.log(`${CLIENTS} clients x ${ROUNDS} rounds, worker "${w.name}", via ${HTTP ? `HTTP ${HTTP}/api/bookings` : 'CALL sp_create_booking'}\n`);
  let allOk = true;
  for (let round = 1; round <= ROUNDS; round++) {
    // a slot far in the future (day 40+) so it never overlaps the seeded calendar
    const { rows: [s] } = await admin.query(
      `INSERT INTO availability_slot (worker_id, start_time, end_time)
       VALUES ($1, date_trunc('day', now()) + interval '40 days' + $2 * interval '3 hours', date_trunc('day', now()) + interval '40 days' + $2 * interval '3 hours' + interval '2 hours')
       RETURNING slot_id`, [w.worker_id, round]);
    const reqs: { id: number; customer: number }[] = [];
    for (let i = 0; i < CLIENTS; i++) {
      const customer = customers[i % customers.length];
      const { rows: [r] } = await admin.query(`INSERT INTO service_request (customer_id, description) VALUES ($1, 'concurrency test') RETURNING request_id`, [customer]);
      reqs.push({ id: r.request_id, customer });
    }

    // the race: everybody fires at once
    const t = Date.now();
    const results = await Promise.all(reqs.map(async (r, i) => {
      try {
        if (HTTP) {
          const res = await fetch(`${HTTP}/api/bookings`, {
            method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieFor(r.customer) },
            body: JSON.stringify({ request_id: r.id, worker_id: w.worker_id, slot_id: s.slot_id }),
          });
          const body = await res.json().catch(() => ({}));
          return res.status === 201 ? 'ok' : (body?.error?.code ?? `HTTP ${res.status}`);
        }
        await conns[i].query('CALL sp_create_booking($1, $2, $3, $4, NULL, NULL)', [r.customer, r.id, w.worker_id, s.slot_id]);
        return 'ok';
      } catch (e) {
        const code = (e as { code?: string }).code;
        return code === 'SM001' ? 'SLOT_TAKEN' : code === '23505' ? 'UNIQUE_INDEX' : `ERROR ${code ?? (e as Error).message}`;
      }
    }));
    const ms = Date.now() - t;

    const counts = results.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
    const { rows: [db] } = await admin.query(
      `SELECT (SELECT count(*)::int FROM booking WHERE slot_id = $1 AND status <> 'cancelled') AS live_bookings,
              (SELECT count(*)::int FROM invoice i JOIN booking b USING (booking_id) WHERE b.slot_id = $1) AS invoices,
              (SELECT status FROM availability_slot WHERE slot_id = $1) AS slot_status`, [s.slot_id]);
    const ok = counts.ok === 1 && db.live_bookings === 1 && db.invoices === 1 && db.slot_status === 'reserved'
      && Object.keys(counts).every((k) => k === 'ok' || k === 'SLOT_TAKEN' || k === 'UNIQUE_INDEX');
    allOk &&= ok;
    console.log(`round ${String(round).padStart(2)}: ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(counts)}  db=${JSON.stringify(db)}  ${ms} ms`);

    // clean up this round's rows
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('sm.booking_proc', 'on', true)`);
    await admin.query('DELETE FROM invoice WHERE booking_id IN (SELECT booking_id FROM booking WHERE slot_id = $1)', [s.slot_id]);
    await admin.query('DELETE FROM booking WHERE slot_id = $1', [s.slot_id]);
    await admin.query('DELETE FROM service_request WHERE request_id = ANY($1::int[])', [reqs.map((r) => r.id)]);
    await admin.query('DELETE FROM availability_slot WHERE slot_id = $1', [s.slot_id]);
    await admin.query('COMMIT');
  }
  for (const c of conns) await c.end();
  await admin.end();
  console.log(allOk ? `\nPASS: no double booking in ${ROUNDS} rounds of ${CLIENTS} simultaneous attempts.` : '\nFAIL: see the rounds above.');
  if (!allOk) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
