import type { ErrorRequestHandler } from 'express';
import { AppError, Errors, isDuplicateKeyError } from '../lib/errors.js';
import { sendError } from '../lib/response.js';

interface HttpLikeError {
  type: string;
  status: number;
}

/** body-parser (used by express.json) throws errors carrying `type` and `status`. */
function isBodyParserError(err: unknown): err is HttpLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as Partial<HttpLikeError>).type === 'string' &&
    typeof (err as Partial<HttpLikeError>).status === 'number'
  );
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (isBodyParserError(err)) {
    switch (err.type) {
      case 'entity.parse.failed':
        return new AppError(400, 'BAD_REQUEST', 'Malformed JSON body');
      case 'entity.too.large':
        return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
      case 'charset.unsupported':
      case 'encoding.unsupported':
        return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported request encoding');
      default:
        if (err.status >= 400 && err.status < 500) {
          return new AppError(err.status, 'BAD_REQUEST', 'Invalid request body');
        }
    }
  }

  // A unique index rejected a write. Services handle the cases they expect (e.g. "username taken");
  // this fallback keeps a race we didn't anticipate from surfacing as a 500.
  // The key value is deliberately not echoed back.
  if (isDuplicateKeyError(err)) return Errors.conflict('Resource already exists');

  return Errors.internal(err);
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    // e.g. the handler failed after the timeout middleware already replied.
    // Delegating lets Express close the connection.
    req.log.warn({ err }, 'Error raised after response was sent');
    next(err);
    return;
  }

  const appError = toAppError(err);
  // Only bugs are logged here. Deliberate AppErrors (including 503s such as "not ready")
  // are logged with context where they are raised, and must not trip error-rate alerts.
  if (appError.code === 'INTERNAL_ERROR') {
    req.log.error({ err }, 'Unhandled error');
  }
  sendError(req, res, appError);
};
