import type { UserSearchQuery, UserSearchResultDto } from '@vibe/shared';
import type { Types } from 'mongoose';
import { canSeeProfile } from '../../policies/visibility.js';
import { getRelationships } from '../relationships/relationship.service.js';
import { toUserSummary } from '../users/user.queries.js';
import { UserModel, type UserRecord } from '../users/user.model.js';
import { normalizeForSearch, searchTokensFor } from '../users/user.search.js';
import type { AuthUser } from '../users/user.service.js';

type Candidate = Pick<
  UserRecord,
  '_id' | 'displayName' | 'avatarUrl' | 'clerkImageUrl' | 'isPrivate' | 'counts'
> & { username: string };

const PROJECTION = {
  username: 1,
  displayName: 1,
  avatarUrl: 1,
  clerkImageUrl: 1,
  isPrivate: 1,
  counts: 1,
} as const;

/** Over-fetch per source, so dropping blocked accounts and merging still fills a page. */
const CANDIDATE_FACTOR = 2;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An anchored, case-sensitive prefix regex is the only regex form MongoDB turns into index bounds. */
const prefix = (text: string) => new RegExp(`^${escapeRegex(text)}`);

export type SearchService = ReturnType<typeof createSearchService>;

export function createSearchService() {
  return {
    /**
     * Two index range scans run in parallel: a username prefix match (the unique username index) and
     * a display-name word-prefix match (the multikey searchTokens index). Results are merged and
     * ranked in memory: exact handle, then handle prefix, then name match; ties by follower count.
     * Accounts that blocked the viewer, or that the viewer blocked, are left out.
     */
    async searchUsers(
      viewer: AuthUser,
      { q, limit }: UserSearchQuery,
    ): Promise<UserSearchResultDto[]> {
      const text = normalizeForSearch(q).trim();
      const handle = text.replace(/^@/, '').replace(/[^a-z0-9_.]/g, '');
      const words = text.startsWith('@') ? [] : searchTokensFor(text);
      if (!handle && words.length === 0) return [];

      const take = limit * CANDIDATE_FACTOR;
      const active = { deletedAt: null };
      const [byHandle, byName] = await Promise.all([
        handle
          ? UserModel.find({ ...active, username: prefix(handle) }, PROJECTION)
              .limit(take)
              .lean<Candidate[]>()
          : Promise.resolve([]),
        words.length > 0
          ? UserModel.find(
              {
                ...active,
                username: { $type: 'string' },
                // Every query word must start some word of the name: "gr hop" → Grace Hopper.
                searchTokens: { $all: words.map(prefix) },
              },
              PROJECTION,
            )
              .limit(take)
              .lean<Candidate[]>()
          : Promise.resolve([]),
      ]);

      const rank = new Map<string, { user: Candidate; score: number }>();
      const consider = (user: Candidate, score: number) => {
        const id = user._id.toHexString();
        const seen = rank.get(id);
        if (!seen || score < seen.score) rank.set(id, { user, score });
      };
      for (const user of byHandle) consider(user, user.username === handle ? 0 : 1);
      for (const user of byName) consider(user, 2);

      const ordered = [...rank.values()].sort(
        (a, b) =>
          a.score - b.score ||
          b.user.counts.followers - a.user.counts.followers ||
          a.user.username.localeCompare(b.user.username),
      );
      const relationships = await getRelationships(
        viewer.id,
        ordered.map(({ user }) => idOf(user._id)),
      );

      return ordered
        .flatMap(({ user }) => {
          const rel = relationships.get(idOf(user._id));
          if (!rel || !canSeeProfile(rel) || rel.blockedByViewer) return [];
          return [
            {
              ...toUserSummary(user),
              isPrivate: user.isPrivate,
              ...(!rel.isSelf && { viewer: { following: rel.following } }),
            },
          ];
        })
        .slice(0, limit);
    },
  };
}

const idOf = (id: Types.ObjectId) => id.toHexString();
