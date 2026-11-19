// Helpers for server actions: run a use case, then redirect back with a success or error message.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { toAppError } from './errors';

export function withMsg(path: string, key: 'ok' | 'err', msg?: string): string {
  if (!msg) return path;
  const [base, hash] = path.split('#');
  const url = new URL(base, 'http://x');
  url.searchParams.delete('ok');
  url.searchParams.delete('err');
  url.searchParams.set(key, msg);
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ''}`;
}

/**
 * Runs fn. On error: redirect to `back` with ?err=<message>.
 * On success: redirect to the returned `to` (or `back`) with ?ok=<message>.
 */
export async function run(back: string, fn: () => Promise<{ to?: string; ok?: string } | void>): Promise<never> {
  let result: { to?: string; ok?: string } | void;
  try {
    result = await fn();
  } catch (e) {
    redirect(withMsg(back, 'err', toAppError(e).message));
  }
  revalidatePath('/', 'layout');
  redirect(withMsg(result?.to ?? back, 'ok', result?.ok));
}

export function int(v: FormDataEntryValue | null | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export const str = (v: FormDataEntryValue | null | undefined): string => (typeof v === 'string' ? v : '');

/** Only allow redirects to our own pages. */
export const safeBack = (v: FormDataEntryValue | null, fallback: string): string => {
  const s = str(v);
  return s.startsWith('/') && !s.startsWith('//') ? s : fallback;
};
