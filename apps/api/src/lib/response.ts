import type { ApiErrorBody, ApiSuccess, PageMeta } from '@vibe/shared';
import type { Request, Response } from 'express';
import type { AppError } from './errors.js';

export function sendData<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccess<T> = { data };
  res.status(status).json(body);
}

export function sendPage<T>(res: Response, items: T[], meta: PageMeta): void {
  const body: ApiSuccess<T[]> = { data: items, meta };
  res.status(200).json(body);
}

export function sendError(req: Request, res: Response, error: AppError): void {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined && { details: error.details }),
      // app.ts generates string ids; pino-http's default generator yields numbers.
      ...((typeof req.id === 'string' || typeof req.id === 'number') && {
        requestId: String(req.id),
      }),
    },
  };
  res.status(error.status).json(body);
}
