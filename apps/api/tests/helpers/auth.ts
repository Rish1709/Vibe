import { randomUUID } from 'node:crypto';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { createClerkTokenVerifier } from '../../src/infra/clerk.js';
import type { IdentityProfile, IdentityProvider } from '../../src/modules/users/identity.js';
import { silentLogger } from './testApp.js';

export const TEST_FRONTEND_ORIGIN = 'http://localhost:5173';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');

/**
 * The production Clerk verifier, configured with a locally generated public key (Clerk's
 * networkless mode). Tests exercise the real signature, expiry and `azp` checks.
 */
export const testTokenVerifier = createClerkTokenVerifier({
  secretKey: 'sk_test_unused_in_networkless_mode',
  jwtKey: await exportSPKI(publicKey),
  authorizedParties: [TEST_FRONTEND_ORIGIN],
  logger: silentLogger,
});

interface TokenOptions {
  expiresInSeconds?: number;
  azp?: string;
  signWithUntrustedKey?: boolean;
}

/** Mints a token shaped like a Clerk session token (v2 claims). */
export async function signSessionToken(clerkId: string, options: TokenOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 60;
  return new SignJWT({
    sid: `sess_${randomUUID()}`,
    azp: options.azp ?? TEST_FRONTEND_ORIGIN,
    v: 2,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'ins_test' })
    .setSubject(clerkId)
    .setIssuer('https://test.clerk.accounts.dev')
    .setIssuedAt(now - 1)
    .setNotBefore(now - 1)
    .setExpirationTime(now + expiresIn)
    .sign(options.signWithUntrustedKey ? otherKeys.privateKey : privateKey);
}

export const newClerkId = () => `user_${randomUUID().replace(/-/g, '')}`;

/**
 * In-memory stand-in for Clerk's user API (an external HTTP service). Records calls so tests can
 * assert how often provisioning reached the provider.
 */
export function createTestIdentityProvider() {
  const users = new Map<string, IdentityProfile>();
  let failing = false;
  const calls: string[] = [];

  const provider: IdentityProvider = {
    getUser(clerkId) {
      calls.push(clerkId);
      if (failing) return Promise.reject(new Error('Clerk API unavailable'));
      const user = users.get(clerkId);
      return user ? Promise.resolve(user) : Promise.reject(new Error(`No Clerk user ${clerkId}`));
    },
  };

  return {
    provider,
    calls,
    add(clerkId: string, profile: Partial<IdentityProfile> = {}) {
      users.set(clerkId, {
        clerkId,
        email: `${clerkId}@example.com`,
        name: 'Test User',
        imageUrl: null,
        updatedAt: new Date(),
        ...profile,
      });
      return clerkId;
    },
    setFailing(value: boolean) {
      failing = value;
    },
  };
}
