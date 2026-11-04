import {
  STORY_TTL_HOURS,
  type CreateStoryInput,
  type PageMeta,
  type StoryDto,
  type StoryGroupDto,
  type UserListItemDto,
} from '@vibe/shared';
import { Types } from 'mongoose';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { canSeeProfile, canViewContent } from '../../policies/visibility.js';
import { toMediaDto, type MediaService } from '../media/media.service.js';
import { FollowModel } from '../relationships/follow.model.js';
import { getRelationship, getRelationships } from '../relationships/relationship.service.js';
import { findAuthors, findUserSummaries, requireActiveUser } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import {
  StoryModel,
  StoryViewModel,
  type StoryRecord,
  type StoryViewRecord,
} from './story.model.js';

/** Bounds a user's tray ring (and the tray query) no matter how much someone posts. */
const MAX_ACTIVE_STORIES = 100;
const STORY_TTL_MS = STORY_TTL_HOURS * 3600 * 1000;

/** Active = not deleted and not expired, checked at query time (never trusting TTL deletion). */
const active = (now: Date) => ({ deletedAt: null, expiresAt: { $gt: now } });

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

export type StoryService = ReturnType<typeof createStoryService>;

export function createStoryService({ media }: { media: MediaService }) {
  function toDto(story: StoryRecord, viewerId: string, seen: boolean): StoryDto {
    const isAuthor = story.authorId.equals(viewerId);
    return {
      id: story._id.toHexString(),
      media: toMediaDto(story.media),
      caption: story.caption ?? null,
      createdAt: story.createdAt.toISOString(),
      expiresAt: story.expiresAt.toISOString(),
      viewer: { seen: isAuthor || seen, isAuthor },
      viewCount: isAuthor ? story.viewCount : null,
    };
  }

  /** An active story the viewer may see, or 404 (expired, deleted and forbidden look the same). */
  async function loadVisibleStory(viewer: AuthUser, storyId: string): Promise<StoryRecord> {
    const story = await StoryModel.findOne({
      _id: storyId,
      ...active(new Date()),
    }).lean<StoryRecord>();
    if (!story) throw Errors.notFound('Story not found');
    if (story.authorId.equals(viewer.id)) return story;
    const author = await requireActiveUser(story.authorId.toHexString()).catch(() => null);
    const rel = await getRelationship(viewer.id, story.authorId.toHexString());
    if (!author || !canViewContent(rel, author)) throw Errors.notFound('Story not found');
    return story;
  }

  async function seenSet(viewerId: string, storyIds: Types.ObjectId[]): Promise<Set<string>> {
    if (storyIds.length === 0) return new Set();
    const views = await StoryViewModel.find(
      { viewerId: new Types.ObjectId(viewerId), storyId: { $in: storyIds } },
      { storyId: 1 },
    ).lean();
    return new Set(views.map((view) => view.storyId.toHexString()));
  }

  return {
    async create(viewer: AuthUser, input: CreateStoryInput): Promise<StoryDto> {
      const now = new Date();
      const activeCount = await StoryModel.countDocuments({ authorId: viewer.id, ...active(now) });
      if (activeCount >= MAX_ACTIVE_STORIES)
        throw Errors.badRequest('You have too many active stories');

      const [attached] = await media.claim(viewer, [input.mediaId], 'story');
      if (!attached) throw Errors.badRequest('Upload not found');
      try {
        const story = await StoryModel.create({
          authorId: viewer.id,
          media: attached,
          caption: input.caption || null,
          expiresAt: new Date(now.getTime() + STORY_TTL_MS),
        });
        return toDto(story.toObject<StoryRecord>(), viewer.id, true);
      } catch (err) {
        await media.unclaim([attached.mediaId]);
        throw err;
      }
    },

    /**
     * The tray: one group per followed author (plus the viewer) with active stories, oldest first within
     * a group (playback order). Groups with unseen stories come first, then by most recent story.
     * Query cost: followee ids, one ranged $in over { authorId, expiresAt }, authors, relationships and
     * the viewer's views. Constant query count however many people the viewer follows.
     */
    async tray(viewer: AuthUser): Promise<StoryGroupDto[]> {
      const follows = await FollowModel.find(
        { followerId: new Types.ObjectId(viewer.id), status: 'active' },
        { followeeId: 1 },
      ).lean();
      const authorIds = [
        new Types.ObjectId(viewer.id),
        ...follows.map((follow) => follow.followeeId),
      ];
      const stories = await StoryModel.find({ authorId: { $in: authorIds }, ...active(new Date()) })
        .sort({ createdAt: 1, _id: 1 })
        .lean<StoryRecord[]>();
      if (stories.length === 0) return [];

      const ids = [...new Set(stories.map((story) => story.authorId.toHexString()))];
      const [authors, relationships, seen] = await Promise.all([
        findAuthors(ids),
        getRelationships(viewer.id, ids),
        seenSet(
          viewer.id,
          stories.map((story) => story._id),
        ),
      ]);

      const groups = new Map<string, StoryGroupDto>();
      for (const story of stories) {
        const authorId = story.authorId.toHexString();
        const author = authors.get(authorId);
        const rel = relationships.get(authorId);
        if (!author || !rel || !canViewContent(rel, author)) continue;
        const group = groups.get(authorId) ?? {
          author: author.summary,
          stories: [],
          hasUnseen: false,
        };
        const dto = toDto(story, viewer.id, seen.has(story._id.toHexString()));
        group.stories.push(dto);
        group.hasUnseen ||= !dto.viewer.seen;
        groups.set(authorId, group);
      }

      const latest = (group: StoryGroupDto) => group.stories.at(-1)?.createdAt ?? '';
      return [...groups.values()].sort((a, b) => {
        if (a.author.id === viewer.id) return -1;
        if (b.author.id === viewer.id) return 1;
        if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
        return latest(b).localeCompare(latest(a));
      });
    },

    async listForUser(viewer: AuthUser, userId: string): Promise<StoryDto[]> {
      const author = await requireActiveUser(userId);
      const rel = await getRelationship(viewer.id, userId);
      if (!canSeeProfile(rel)) throw Errors.notFound('User not found');
      if (!canViewContent(rel, author)) throw Errors.forbidden('This account is private');
      const stories = await StoryModel.find({ authorId: author._id, ...active(new Date()) })
        .sort({ createdAt: 1, _id: 1 })
        .lean<StoryRecord[]>();
      const seen = await seenSet(
        viewer.id,
        stories.map((story) => story._id),
      );
      return stories.map((story) => toDto(story, viewer.id, seen.has(story._id.toHexString())));
    },

    /**
     * Records a view. Idempotent and race-safe like likes: the unique (storyId, viewerId) index means
     * one view per person, and only the call that inserted increments the count. Authors viewing their
     * own story don't count.
     */
    async markViewed(viewer: AuthUser, storyId: string): Promise<{ seen: true }> {
      const story = await loadVisibleStory(viewer, storyId);
      if (story.authorId.equals(viewer.id)) return { seen: true };
      let inserted = false;
      try {
        const result = await StoryViewModel.updateOne(
          { storyId: story._id, viewerId: new Types.ObjectId(viewer.id) },
          { $setOnInsert: { expiresAt: story.expiresAt } },
          { upsert: true },
        );
        inserted = result.upsertedCount === 1;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
      if (inserted) await StoryModel.updateOne({ _id: story._id }, { $inc: { viewCount: 1 } });
      return { seen: true };
    },

    /** Only the author sees who viewed, and only while the story is active. */
    async listViewers(
      viewer: AuthUser,
      storyId: string,
      { cursor, limit }: PageInput,
    ): Promise<{ items: UserListItemDto[]; meta: PageMeta }> {
      const story = await StoryModel.findOne({
        _id: storyId,
        authorId: viewer.id,
        ...active(new Date()),
      }).lean<StoryRecord>();
      if (!story) throw Errors.notFound('Story not found');
      const rows = await StoryViewModel.find({
        storyId: story._id,
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<StoryViewRecord[]>();
      const { items: views, meta } = keysetPage(rows, limit);
      const summaries = await findUserSummaries(views.map((view) => view.viewerId.toHexString()));
      const items = views.flatMap((view) => {
        const summary = summaries.get(view.viewerId.toHexString());
        return summary ? [summary] : [];
      });
      return { items, meta };
    },

    async remove(viewer: AuthUser, storyId: string): Promise<void> {
      const deleted = await StoryModel.findOneAndUpdate(
        { _id: storyId, authorId: viewer.id, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { projection: { media: 1 } },
      ).lean<Pick<StoryRecord, 'media'>>();
      if (!deleted) throw Errors.notFound('Story not found');
      await media.release([deleted.media.mediaId]);
    },
  };
}
