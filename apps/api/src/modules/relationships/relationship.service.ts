import type { FollowState } from '@vibe/shared';
import { Types } from 'mongoose';
import { BlockModel } from './block.model.js';
import { FollowModel } from './follow.model.js';

/** How the viewer relates to one other account. Input to every visibility decision. */
export interface Relationship {
  isSelf: boolean;
  following: FollowState;
  followedBy: boolean;
  /** The viewer blocked them. */
  blockedByViewer: boolean;
  /** They blocked the viewer. */
  blockingViewer: boolean;
}

const SELF: Relationship = {
  isSelf: true,
  following: 'none',
  followedBy: false,
  blockedByViewer: false,
  blockingViewer: false,
};

const toObjectIds = (ids: Iterable<string>) =>
  [...new Set(ids)].map((id) => new Types.ObjectId(id));

/**
 * Resolves the viewer's relationship to many accounts in three indexed queries total,
 * independent of how many accounts are asked about. This is what keeps lists of posts or users
 * free of N+1 lookups.
 */
export async function getRelationships(
  viewerId: string,
  targetIds: Iterable<string>,
): Promise<Map<string, Relationship>> {
  const others = toObjectIds([...targetIds].filter((id) => id !== viewerId));
  const viewer = new Types.ObjectId(viewerId);
  const result = new Map<string, Relationship>([[viewerId, SELF]]);
  if (others.length === 0) return result;

  const [blocks, outgoing, incoming] = await Promise.all([
    BlockModel.find(
      {
        $or: [
          { blockerId: viewer, blockedId: { $in: others } },
          { blockerId: { $in: others }, blockedId: viewer },
        ],
      },
      { blockerId: 1, blockedId: 1 },
    ).lean(),
    FollowModel.find(
      { followerId: viewer, followeeId: { $in: others } },
      { followeeId: 1, status: 1 },
    ).lean(),
    FollowModel.find(
      { followerId: { $in: others }, followeeId: viewer, status: 'active' },
      { followerId: 1 },
    ).lean(),
  ]);

  for (const id of others) {
    result.set(id.toHexString(), {
      isSelf: false,
      following: 'none',
      followedBy: false,
      blockedByViewer: false,
      blockingViewer: false,
    });
  }
  for (const block of blocks) {
    if (block.blockerId.equals(viewer)) {
      const rel = result.get(block.blockedId.toHexString());
      if (rel) rel.blockedByViewer = true;
    } else {
      const rel = result.get(block.blockerId.toHexString());
      if (rel) rel.blockingViewer = true;
    }
  }
  for (const edge of outgoing) {
    const rel = result.get(edge.followeeId.toHexString());
    if (rel) rel.following = edge.status;
  }
  for (const edge of incoming) {
    const rel = result.get(edge.followerId.toHexString());
    if (rel) rel.followedBy = true;
  }
  return result;
}

export async function getRelationship(viewerId: string, targetId: string): Promise<Relationship> {
  const relationships = await getRelationships(viewerId, [targetId]);
  // getRelationships always returns an entry for every requested id.
  return relationships.get(targetId) as Relationship;
}

/** True if either side has blocked the other. Used by writes that must re-check after inserting. */
export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const [x, y] = [new Types.ObjectId(a), new Types.ObjectId(b)];
  const found = await BlockModel.exists({
    $or: [
      { blockerId: x, blockedId: y },
      { blockerId: y, blockedId: x },
    ],
  });
  return found !== null;
}
