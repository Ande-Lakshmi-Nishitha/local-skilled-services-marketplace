// Shared contract between Person A and Person B.  FROZEN after Day 1 - see docs/CHANGELOG.md for changes.
// Both sides import from here (copy/symlink to web/src/lib/contracts.ts).  Keep it dependency-free.

export type Role = 'customer' | 'worker' | 'admin';

export type VerificationStatus = 'pending' | 'verified' | 'rejected';
export type SlotStatus = 'open' | 'reserved' | 'blocked';
export type RequestStatus = 'open' | 'booked' | 'closed' | 'cancelled';
export type BookingStatus = 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type InvoiceStatus = 'issued' | 'paid' | 'void' | 'refunded' | 'partially_refunded';
export type PaymentStatus = 'pending' | 'success' | 'failed' | 'refunded' | 'partially_refunded';
export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'cash';
export type DisputeStatus = 'open' | 'resolved' | 'rejected';
export type RaisedByRole = 'customer' | 'worker' | 'system';
export type RefundPolicy = 'full' | 'partial' | 'none';

export type ErrorCode =
  | 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'SLOT_TAKEN' | 'SLOT_IN_PAST' | 'SLOT_OVERLAP' | 'SLOT_WORKER_MISMATCH' | 'SLOT_NOT_EDITABLE'
  | 'REQUEST_NOT_OPEN' | 'REQUEST_NOT_OWNED' | 'WORKER_NOT_VERIFIED'
  | 'BOOKING_NOT_CANCELLABLE' | 'INVALID_STATUS_TRANSITION'
  | 'INVOICE_NOT_PAYABLE' | 'RATING_NOT_ALLOWED' | 'DISPUTE_NOT_OPEN'
  | 'EMBEDDING_FAILED' | 'INTERNAL';

export interface ApiErrorBody { error: { code: ErrorCode; message: string } }

export interface Session { role: Role; id: number; name: string }

// ---- shared small shapes --------------------------------------------------
export interface CategoryRef { category_id: number; name: string }
export interface SlotDTO { slot_id: number; worker_id: number; start_time: string; end_time: string; status: SlotStatus } // ISO-8601 UTC

// ---- Person B: requests, matching, profiles -------------------------------
export interface CreateRequestBody { description: string }               // 5..1000 chars
export interface ServiceRequestDTO {
  request_id: number; customer_id: number; description: string; status: RequestStatus; created_at: string;
}

export interface MatchDTO {
  worker_id: number;
  name: string;
  locality: string;
  bio_snippet: string;                 // first ~160 chars of bio
  hourly_rate: number;
  avg_rating: number | null;
  rating_count: number;
  similarity: number;                  // cosine similarity 0..1 (best of skill/bio embedding)
  trust_score: number;                 // Bayesian-smoothed rating, 0..5
  final_score: number;                 // alpha*similarity + (1-alpha)*trust/5
  categories: CategoryRef[];
  next_open_slot: { slot_id: number; start_time: string; end_time: string };   // matching requires >= 1 open future slot
  portfolio_preview: { trade: string; photo_url: string | null } | null;       // from MongoDB
}
export interface MatchesResponse { request_id: number; matches: MatchDTO[] }

export interface PortfolioDTO {
  trade: string;
  photos: { url: string; caption?: string }[];
  certifications: { name: string; issuer?: string; number?: string; issued_year?: number }[];
  trade_attributes: Record<string, unknown> & { skills?: string[] };   // `skills` is the one agreed key
}

export interface WorkerProfileDTO {
  worker_id: number; name: string; locality: string; bio: string | null; hourly_rate: number;
  verification_status: VerificationStatus; avg_rating: number | null; rating_count: number;
  categories: CategoryRef[];
  portfolio: PortfolioDTO | null;
  recent_ratings: { score: number; comment: string | null; created_at: string }[];   // newest 5
}

export interface UpsertWorkerBody {
  name: string; email: string; phone?: string; locality: string; bio?: string; hourly_rate: number;
  category_ids: number[]; trade: string; skills: string[];
}

// ---- Person A: slots, bookings, money, moderation -------------------------
export interface CreateBookingBody { request_id: number; worker_id: number; slot_id: number }
export interface InvoiceDTO { invoice_id: number; booking_id: number; amount: number; status: InvoiceStatus; issued_at: string }
export interface BookingDTO {
  booking_id: number; request_id: number; worker_id: number; worker_name: string; customer_id: number; customer_name: string;
  status: BookingStatus; created_at: string; cancelled_at: string | null;
  slot: { slot_id: number; start_time: string; end_time: string };
  request_description: string;
  invoice: InvoiceDTO | null;
  rating: { score: number; comment: string | null } | null;
}
export interface CancelBookingResponse { booking_id: number; status: 'cancelled'; refund_amount: number; refund_policy: RefundPolicy }
export interface PayInvoiceBody { method: PaymentMethod }
export interface PaymentDTO { payment_id: number; invoice_id: number; amount: number; method: PaymentMethod; status: PaymentStatus; refund_amount: number; paid_at: string | null }
export interface RateBody { score: 1 | 2 | 3 | 4 | 5; comment?: string }
export interface DisputeDTO {
  dispute_id: number; booking_id: number; raised_by_role: RaisedByRole; reason: string; status: DisputeStatus;
  resolved_by: number | null; resolution_note: string | null; created_at: string;
}
export interface LeaderboardRow {
  category_id: number; category_name: string; worker_id: number; name: string;
  avg_rating: number | null; rating_count: number; bayesian_score: number; completed_jobs: number; rank_in_category: number;
}
