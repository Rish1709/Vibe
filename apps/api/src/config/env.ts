import { z } from 'zod';

const commaSeparated = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// URI'),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(20),

  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URI'),

  CORS_ORIGINS: commaSeparated.pipe(z.array(z.url()).min(1)),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Per-IP budget before authentication. Raise it behind large NATs or in shared test environments.
  RATE_LIMIT_ANONYMOUS_PER_MINUTE: z.coerce.number().int().positive().default(600),
  // Authors with at least this many followers are not fanned out on write; their posts are merged
  // into followers' feeds at read time. See INTERVIEW/caching-strategy.md.
  FEED_CELEBRITY_THRESHOLD: z.coerce.number().int().positive().default(10_000),
  // Namespaces BullMQ keys, so environments (or parallel test runs) sharing a Redis don't collide.
  QUEUE_PREFIX: z
    .string()
    .regex(/^[\w-]+$/)
    .default('vibe'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, 'must be a Clerk secret key (sk_...)'),
  // PEM public key for networkless token verification. Env files can't hold raw newlines
  // reliably, so `\n` escapes are accepted. Without it, Clerk's JWKS is fetched (and cached).
  CLERK_JWT_KEY: z
    .string()
    .transform((value) => value.replace(/\\n/g, '\n'))
    .pipe(z.string().startsWith('-----BEGIN PUBLIC KEY-----'))
    .optional(),
  // Frontend origins allowed to mint session tokens for this API (the `azp` claim).
  CLERK_AUTHORIZED_PARTIES: commaSeparated.pipe(z.array(z.url())).optional(),
  // Without it the webhook endpoint answers 503; users are still provisioned lazily on first request.
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().startsWith('whsec_').optional(),

  // ImageKit (Dashboard -> Developer options). Optional: without them, media endpoints answer 503.
  IMAGEKIT_PUBLIC_KEY: z.string().startsWith('public_').optional(),
  IMAGEKIT_PRIVATE_KEY: z.string().startsWith('private_').optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates configuration once at startup so a misconfigured process fails immediately
 * instead of on the first request that touches the bad value.
 * Error messages name the variable but never echo its value (it may be a secret).
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // `KEY=` in an env file means "not set", not "set to an empty string".
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = envSchema.safeParse(defined);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return result.data;
}
