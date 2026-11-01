/** Structured API error codes shared by server and clients. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  REFRESH_TOKEN_REUSED: 401,
  ACCOUNT_LOCKED: 423,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  INSUFFICIENT_STOCK: 409,
  STOCK_NOT_RELEASED: 409,
  PRECONDITION_FAILED: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  IDEMPOTENCY_IN_PROGRESS: 409,
  UNIT_CONVERSION_NOT_ALLOWED: 422,
  FABRIC_GEOMETRY_REQUIRED: 422,
  SELF_APPROVAL_FORBIDDEN: 403,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody { error: { code: ErrorCode; message: string; details?: unknown; requestId?: string } }

export class AppError extends Error {
  code: ErrorCode; status: number; details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message); this.code = code; this.status = ERROR_CODES[code]; this.details = details; this.name = 'AppError';
  }
}
