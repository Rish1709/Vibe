import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { sendError } from '../lib/response.js';

/**
 * Replies 503 if a handler has not responded within `ms`, so clients and load balancers
 * are not left holding a connection open indefinitely.
 *
 * This bounds the response, not the work: the handler keeps running. Database calls
 * get their own server-side limits (`maxTimeMS`) so slow queries are also cancelled.
 */
export function requestTimeout(ms: number): RequestHandler {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      req.log.warn({ timeoutMs: ms }, 'Request timed out');
      sendError(req, res, new AppError(503, 'REQUEST_TIMEOUT', 'Request timed out'));
    }, ms);
    // 'close' fires both when the response finishes and when the client disconnects.
    res.on('close', () => clearTimeout(timer));
    next();
  };
}
