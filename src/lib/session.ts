// Demo sign-in: pick a seeded customer / worker / admin and get a signed, HTTP-only cookie.
// There are no passwords (the ER model has no credential columns; see docs/03-er-changes.md D2).
// Roles ARE enforced on the server: every page and action calls requireRole().
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export type Role = 'customer' | 'worker' | 'admin';
export interface Session { role: Role; id: number; name: string }

const COOKIE = 'sm_session';

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET must be set (16+ characters)');
    return 'dev-only-insecure-secret-change-me';
  }
  return s;
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function encodeSession(s: Session): string {
  const payload = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    if (!['customer', 'worker', 'admin'].includes(s.role) || !Number.isInteger(s.id)) return null;
    return s;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  return decodeSession((await cookies()).get(COOKIE)?.value);
}

export async function setSession(s: Session): Promise<void> {
  (await cookies()).set(COOKIE, encodeSession(s), {
    httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** For pages and server actions: redirect to the sign-in page unless the user has this role. */
export async function requireRole(role: Role): Promise<Session> {
  const s = await getSession();
  if (!s || s.role !== role) redirect(`/login?need=${role}`);
  return s;
}

export function homeFor(role: Role): string {
  return role === 'customer' ? '/customer' : role === 'worker' ? '/worker' : '/admin';
}
