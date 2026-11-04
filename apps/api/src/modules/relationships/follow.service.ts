import type { FollowRequestDto, FollowResultDto, PageMeta, UserListItemDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { canFollow, canSeeProfile, canViewContent } from '../../policies/visibility.js';
import { adjustFollowCounts, findUserSummaries, requireActiveUser } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import type { FeedWriter } from '../feed/feed.writer.js';
import { FollowModel, type FollowRecord } from './follow.model.js';
import { getRelationship, getRelationships, isBlockedEitherWay } from './relationship.service.js';

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

export type FollowService = ReturnType<typeof createFollowService>;

export function createFollowService({ feed }: { feed: FeedWriter }) {
  /** Converts edges into user list items, dropping deleted accounts, with the viewer's follow state. */
  async function toUserList(
    viewer: AuthUser,
    edges: FollowRecord[],
    pick: (edge: FollowRecord) => Types.ObjectId,
  ): Promise<UserListItemDto[]> {
    const ids = edges.map((edge) => pick(edge).toHexString());
    const [summaries, relationships] = await Promise.all([
      findUserSummaries(ids),
      getRelationships(viewer.id, ids),
    ]);
    return ids.flatMap((id) => {
      const summary = summaries.get(id);
      if (!summary) return [];
      const rel = relationships.get(id);
      return [rel && !rel.isSelf ? { ...summary, viewer: { following: rel.following } } : summary];
    });
  }

  /** Followers/following lists are content: hidden for private accounts the viewer doesn't follow. */
  async function requireListAccess(viewer: AuthUser, userId: string) {
    const target = await requireActiveUser(userId);
    const rel = await getRelationship(viewer.id, userId);
    if (!canSeeProfile(rel)) throw Errors.notFound('User not found');
    if (!canViewContent(rel, target)) throw Errors.forbidden('This account is private');
    return target;
  }

  async function listEdges(
    filter: Record<string, unknown>,
    { cursor, limit }: PageInput,
  ): Promise<{ edges: FollowRecord[]; meta: PageMeta }> {
    const rows = await FollowModel.find({ ...filter, ...keysetFilter(cursor, 'desc') })
      .sort(keysetSort('desc'))
      .limit(limit + 1)
      .lean<FollowRecord[]>();
    const { items, meta } = keysetPage(rows, limit);
    return { edges: items, meta };
  }

  return {
    /**
     * Idempotent. Public accounts are followed immediately; private ones get a pending request.
     *
     * Race with a concurrent block is handled without a transaction by "insert, then check":
     * block inserts its block row and then deletes edges; follow inserts its edge and then looks for
     * a block. In every interleaving one side observes the other, so no edge survives a block.
     * Counters follow edge ownership: the operation that inserts an active edge adds 1, the one that
     * actually deletes it (deletedCount = 1) subtracts 1.
     */
    async follow(viewer: AuthUser, targetId: string): Promise<FollowResultDto> {
      if (targetId === viewer.id) throw Errors.badRequest("You can't follow yourself");
      const target = await requireActiveUser(targetId);
      const rel = await getRelationship(viewer.id, targetId);
      if (!canSeeProfile(rel)) throw Errors.notFound('User not found');
      if (!canFollow(rel)) throw Errors.forbidden("You can't follow this account");

      const status = target.isPrivate ? 'pending' : 'active';
      let edgeId: Types.ObjectId;
      try {
        const edge = await FollowModel.create({
          followerId: viewer.id,
          followeeId: targetId,
          status,
        });
        edgeId = edge._id;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        const existing = await FollowModel.findOne(
          { followerId: viewer.id, followeeId: targetId },
          { status: 1 },
        ).lean();
        return { following: existing?.status ?? 'none' };
      }
      if (status === 'active') await adjustFollowCounts(viewer.id, targetId, 1);

      if (await isBlockedEitherWay(viewer.id, targetId)) {
        const removed = await FollowModel.deleteOne({ _id: edgeId });
        if (removed.deletedCount === 1 && status === 'active') {
          await adjustFollowCounts(viewer.id, targetId, -1);
        }
        throw Errors.forbidden("You can't follow this account");
      }
      // A new active followee's posts should appear: rebuild the follower's timeline lazily.
      if (status === 'active') await feed.onGraphChanged([viewer.id]);
      return { following: status };
    },

    /** Idempotent: unfollowing someone you don't follow (or cancelling no request) succeeds. */
    async unfollow(viewer: AuthUser, targetId: string): Promise<FollowResultDto> {
      const removed = await FollowModel.findOneAndDelete(
        { followerId: viewer.id, followeeId: targetId },
        { projection: { status: 1 } },
      ).lean();
      if (removed?.status === 'active') {
        await adjustFollowCounts(viewer.id, targetId, -1);
        await feed.onGraphChanged([viewer.id]);
      }
      return { following: 'none' };
    },

    async removeFollower(viewer: AuthUser, followerId: string): Promise<void> {
      const removed = await FollowModel.findOneAndDelete(
        { followerId, followeeId: viewer.id },
        { projection: { status: 1 } },
      ).lean();
      if (removed?.status === 'active') {
        await adjustFollowCounts(followerId, viewer.id, -1);
        await feed.onGraphChanged([followerId]);
      }
    },

    /** The pending -> active transition is a conditional update, so double-accepts count once. */
    async acceptRequest(viewer: AuthUser, requestId: string): Promise<void> {
      const accepted = await FollowModel.findOneAndUpdate(
        { _id: requestId, followeeId: viewer.id, status: 'pending' },
        { $set: { status: 'active' } },
        { projection: { followerId: 1 } },
      ).lean();
      if (!accepted) throw Errors.notFound('Follow request not found');
      await adjustFollowCounts(accepted.followerId, viewer.id, 1);
      await feed.onGraphChanged([accepted.followerId.toHexString()]);
    },

    async declineRequest(viewer: AuthUser, requestId: string): Promise<void> {
      const removed = await FollowModel.deleteOne({
        _id: requestId,
        followeeId: viewer.id,
        status: 'pending',
      });
      if (removed.deletedCount === 0) throw Errors.notFound('Follow request not found');
    },

    async listRequests(viewer: AuthUser, page: PageInput) {
      const { edges, meta } = await listEdges(
        { followeeId: new Types.ObjectId(viewer.id), status: 'pending' },
        page,
      );
      const summaries = await findUserSummaries(edges.map((edge) => edge.followerId.toHexString()));
      const items: FollowRequestDto[] = edges.flatMap((edge) => {
        const user = summaries.get(edge.followerId.toHexString());
        return user
          ? [{ id: edge._id.toHexString(), user, createdAt: edge.createdAt.toISOString() }]
          : [];
      });
      return { items, meta };
    },

    async listFollowers(viewer: AuthUser, userId: string, page: PageInput) {
      await requireListAccess(viewer, userId);
      const { edges, meta } = await listEdges(
        { followeeId: new Types.ObjectId(userId), status: 'active' },
        page,
      );
      return { items: await toUserList(viewer, edges, (edge) => edge.followerId), meta };
    },

    async listFollowing(viewer: AuthUser, userId: string, page: PageInput) {
      await requireListAccess(viewer, userId);
      const { edges, meta } = await listEdges(
        { followerId: new Types.ObjectId(userId), status: 'active' },
        page,
      );
      return { items: await toUserList(viewer, edges, (edge) => edge.followeeId), meta };
    },
  };
}
