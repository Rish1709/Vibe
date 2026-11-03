import { createClerkClient } from '@clerk/backend';

/** Identity data owned by the auth provider, normalized to what Vibe stores. */
export interface IdentityProfile {
  clerkId: string;
  email: string | null;
  /** Name from the provider, used only as the initial display name. */
  name: string | null;
  imageUrl: string | null;
  updatedAt: Date;
}

/** Boundary to the auth provider's user API, so services and tests don't depend on Clerk's SDK. */
export interface IdentityProvider {
  getUser(clerkId: string): Promise<IdentityProfile>;
}

export function joinName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}

export function createClerkIdentityProvider(secretKey: string): IdentityProvider {
  const clerk = createClerkClient({ secretKey });
  return {
    async getUser(clerkId) {
      const user = await clerk.users.getUser(clerkId);
      return {
        clerkId: user.id,
        email: user.primaryEmailAddress?.emailAddress ?? null,
        name: joinName(user.firstName, user.lastName),
        imageUrl: user.hasImage ? user.imageUrl : null,
        updatedAt: new Date(user.updatedAt),
      };
    },
  };
}
