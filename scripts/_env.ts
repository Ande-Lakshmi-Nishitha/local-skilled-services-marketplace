// Loads .env for the command-line scripts (Next.js loads it by itself for the web app).
// Real environment variables win over values in the file.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(): void {
  for (const name of ['.env.local', '.env']) {
    const file = resolve(process.cwd(), name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '');
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}

loadEnv();
