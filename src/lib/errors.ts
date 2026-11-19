// One error type for the whole app, and the mapping from database errors to it.

export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'SLOT_TAKEN' | 'SLOT_IN_PAST' | 'SLOT_OVERLAP' | 'SLOT_WORKER_MISMATCH' | 'SLOT_NOT_EDITABLE'
  | 'REQUEST_NOT_OPEN' | 'WORKER_NOT_VERIFIED' | 'BOOKING_NOT_CANCELLABLE' | 'INVALID_STATUS_TRANSITION'
  | 'INVOICE_NOT_PAYABLE' | 'RATING_NOT_ALLOWED' | 'DISPUTE_NOT_OPEN' | 'TOO_EARLY' | 'INVALID_REFUND'
  | 'EMBEDDING_FAILED' | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  SLOT_TAKEN: 409, SLOT_IN_PAST: 422, SLOT_OVERLAP: 409, SLOT_WORKER_MISMATCH: 422, SLOT_NOT_EDITABLE: 409,
  REQUEST_NOT_OPEN: 409, WORKER_NOT_VERIFIED: 422, BOOKING_NOT_CANCELLABLE: 409, INVALID_STATUS_TRANSITION: 409,
  INVOICE_NOT_PAYABLE: 409, RATING_NOT_ALLOWED: 409, DISPUTE_NOT_OPEN: 409, TOO_EARLY: 409, INVALID_REFUND: 422,
  EMBEDDING_FAILED: 502, INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new AppError('VALIDATION', message);
export const notFound = (message = 'Not found') => new AppError('NOT_FOUND', message);
export const forbidden = (message = 'Not allowed') => new AppError('FORBIDDEN', message);

// Custom SQLSTATEs raised by the procedures and triggers (db/postgres/migrations/003, 004).
const SQLSTATE: Record<string, ErrorCode> = {
  SM001: 'SLOT_TAKEN', SM002: 'SLOT_IN_PAST', SM003: 'REQUEST_NOT_OPEN', SM004: 'WORKER_NOT_VERIFIED',
  SM005: 'SLOT_WORKER_MISMATCH', SM006: 'BOOKING_NOT_CANCELLABLE', SM007: 'INVOICE_NOT_PAYABLE',
  SM008: 'INVALID_STATUS_TRANSITION', SM009: 'RATING_NOT_ALLOWED', SM010: 'DISPUTE_NOT_OPEN',
  SM011: 'FORBIDDEN', SM012: 'NOT_FOUND', SM013: 'SLOT_NOT_EDITABLE', SM014: 'TOO_EARLY', SM015: 'INVALID_REFUND',
};

interface PgLikeError { code?: string; message?: string; constraint?: string }

/** Turn anything thrown (pg error, AppError, other) into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const pg = (e ?? {}) as PgLikeError;
  if (pg.code && SQLSTATE[pg.code]) return new AppError(SQLSTATE[pg.code], pg.message ?? pg.code);
  if (pg.code === '23P01') return new AppError('SLOT_OVERLAP', 'That time overlaps one of your existing slots');
  if (pg.code === '23505') {
    if (pg.constraint === 'ux_booking_active_slot') return new AppError('SLOT_TAKEN', 'That slot was just booked by someone else');
    if (pg.constraint === 'worker_email_key') return invalid('A worker with this email is already registered');
    return invalid('That already exists');
  }
  if (pg.code === '23503') return invalid('Something this refers to does not exist');
  if (pg.code === '23514' || pg.code?.startsWith('22')) return invalid('Some values are not valid');
  console.error(e);
  return new AppError('INTERNAL', 'Something went wrong');
}
