import type { ValidationIssue } from '@vibe/shared';
import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { Errors } from './errors.js';

type Location = ValidationIssue['location'];
type RequestSchemas = Partial<Record<Location, z.ZodType>>;

type Parsed<S extends RequestSchemas, K extends Location> = S[K] extends z.ZodType
  ? z.output<S[K]>
  : undefined;

export interface ValidatedInput<S extends RequestSchemas> {
  body: Parsed<S, 'body'>;
  query: Parsed<S, 'query'>;
  params: Parsed<S, 'params'>;
}

const LOCATIONS: readonly Location[] = ['params', 'query', 'body'];

/**
 * Wraps a route handler so it only ever sees schema-validated, typed input.
 *
 * Controllers read `input` instead of the raw `req.body` / `req.query`, which means
 * unvalidated data (including NoSQL operator payloads like `{ "$gt": "" }`) cannot
 * reach the service layer. All locations are validated and all issues reported at once.
 * Express 5 forwards the returned promise's rejection to the error handler.
 */
export function validated<S extends RequestSchemas>(
  schemas: S,
  handler: (input: ValidatedInput<S>, req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return async (req, res) => {
    const issues: ValidationIssue[] = [];
    const input: Partial<Record<Location, unknown>> = {};

    for (const location of LOCATIONS) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location]);
      if (result.success) {
        input[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) throw Errors.validation(issues);
    // Safe: every key present in `schemas` was parsed by that schema above.
    await handler(input as ValidatedInput<S>, req, res);
  };
}
