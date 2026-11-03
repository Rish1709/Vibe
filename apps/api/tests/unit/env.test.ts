import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';

const required = {
  CLERK_SECRET_KEY: 'sk_test_example',
  MONGODB_URI: 'mongodb://localhost:27017/vibe?directConnection=true',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'http://localhost:5173',
};

describe('parseEnv', () => {
  it('applies defaults for optional values', () => {
    const env = parseEnv(required);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      LOG_LEVEL: 'info',
      MONGODB_MAX_POOL_SIZE: 20,
      TRUST_PROXY: 0,
      REQUEST_TIMEOUT_MS: 15_000,
    });
  });

  it('coerces numbers and splits comma-separated origins', () => {
    const env = parseEnv({
      ...required,
      PORT: '8080',
      CORS_ORIGINS: 'http://localhost:5173, https://vibe.example.com ,',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://vibe.example.com']);
  });

  it('treats empty values as unset and unescapes PEM newlines', () => {
    const env = parseEnv({
      ...required,
      CLERK_WEBHOOK_SIGNING_SECRET: '',
      PORT: '',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\\nMIIB\\n-----END PUBLIC KEY-----',
    });
    expect(env.CLERK_WEBHOOK_SIGNING_SECRET).toBeUndefined();
    expect(env.PORT).toBe(4000);
    expect(env.CLERK_JWT_KEY).toBe('-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----');
  });

  it('accepts mongodb+srv and rediss URIs', () => {
    const env = parseEnv({
      ...required,
      MONGODB_URI: 'mongodb+srv://cluster0.example.net/vibe',
      REDIS_URL: 'rediss://cache.example.net:6380',
    });
    expect(env.MONGODB_URI).toContain('mongodb+srv://');
  });

  it('reports every invalid variable at once', () => {
    expect(() => parseEnv({ PORT: '99999', CORS_ORIGINS: 'not-a-url' })).toThrowError();
    try {
      parseEnv({ PORT: '99999', CORS_ORIGINS: 'not-a-url' });
    } catch (err) {
      for (const name of ['PORT', 'MONGODB_URI', 'REDIS_URL', 'CORS_ORIGINS']) {
        expect((err as Error).message).toContain(name);
      }
    }
  });

  it('never echoes values in the error message', () => {
    const secret = 'mysql://user:supersecret@host/db';
    try {
      parseEnv({ ...required, MONGODB_URI: secret });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('MONGODB_URI');
      expect((err as Error).message).not.toContain('supersecret');
    }
  });
});
