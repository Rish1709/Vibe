import type { RequestHandler } from 'express';
import { Errors } from '../lib/errors.js';

export const notFound: RequestHandler = (req) => {
  throw Errors.notFound(`Route ${req.method} ${req.path} not found`);
};
