// Runs the SQL test suites in db/postgres/tests against the configured database.
// Every suite runs in a transaction that is rolled back, so the data is left unchanged.
//   npm run test:db
import './_env';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const DIR = join(process.cwd(), 'db/postgres/tests');

async function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql') && f !== '00_helpers.sql').sort();
  const helpers = readFileSync(join(DIR, '00_helpers.sql'), 'utf8');
  let pass = 0, fail = 0;

  for (const f of files) {
    const client = new Client({ connectionString: process.env.POSTGRES_URL });
    await client.connect();
    console.log(`\n== ${f}`);
    client.on('notice', (n) => {
      if (n.message?.startsWith('PASS')) { pass++; console.log(`  ✓ ${n.message.slice(5)}`); }
    });
    try {
      await client.query(helpers);
      await client.query(readFileSync(join(DIR, f), 'utf8'));
    } catch (e) {
      fail++;
      console.log(`  ✗ ${(e as Error).message}`);
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      await client.end();
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
