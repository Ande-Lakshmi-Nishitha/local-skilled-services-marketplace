// Helpers for the JSON API route handlers (src/app/api/**).
import { AppError, toAppError } from './errors';
import { getSession, type Role, type Session } from './session';

export async function json(fn: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return Response.json(await fn(), { status });
  } catch (e) {
    const err = toAppError(e);
    return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
}

export async function apiRole(role: Role): Promise<Session> {
  const s = await getSession();
  if (!s) throw new AppError('UNAUTHENTICATED', 'Sign in first');
  if (s.role !== role) throw new AppError('FORBIDDEN', `Only a ${role} can do this`);
  return s;
}

export async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new AppError('VALIDATION', 'Body must be a JSON object');
}

export function id(v: unknown, name = 'id'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', `${name} must be a positive integer`);
  return n;
}
