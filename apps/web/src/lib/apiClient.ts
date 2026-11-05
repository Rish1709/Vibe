import { apiErrorSchema, type ApiSuccess, type ErrorCode } from '@vibe/shared';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** 4xx errors are the caller's fault and will fail again if retried unchanged. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

type TokenGetter = () => Promise<string | null>;
let getAuthToken: TokenGetter = () => Promise.resolve(null);

/**
 * Registered by the auth layer once Clerk loads. Clerk session tokens live ~60s, so a fresh token
 * is requested per call (Clerk caches and refreshes it) instead of storing one at sign-in.
 */
export function setAuthTokenGetter(getter: TokenGetter): void {
  getAuthToken = getter;
}

/** A fresh session token, for transports other than fetch (the realtime socket). */
export const currentAuthToken = (): Promise<string | null> => getAuthToken();

/**
 * Thin fetch wrapper: JSON in, typed envelope out, and every non-2xx response
 * (including network failures and non-JSON error pages) normalized into an ApiError.
 */
export async function apiRequest<T>(
  path: string,
  { method = 'GET', body, signal }: RequestOptions = {},
): Promise<ApiSuccess<T>> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) throw err;
    throw new ApiError(0, 'SERVICE_UNAVAILABLE', 'Network error. Check your connection.');
  }

  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      const { code, message, details, requestId } = parsed.data.error;
      throw new ApiError(response.status, code, message, details, requestId);
    }
    throw new ApiError(
      response.status,
      response.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
      `Request failed with status ${response.status}`,
    );
  }

  // The server owns the response contract; shared types keep both sides in sync at compile time.
  return payload as ApiSuccess<T>;
}
