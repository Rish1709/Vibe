import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { CommentModel } from '../../src/modules/comments/comment.model.js';
import { MessageModel } from '../../src/modules/messages/message.models.js';
import { PostModel } from '../../src/modules/posts/post.model.js';
import { StoryModel } from '../../src/modules/stories/story.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createTestMediaProvider, uploadMedia } from '../helpers/media.js';
import { createWorld, type TestUser } from '../helpers/world.js';

/**
 * Phase 9 security review, as an executable checklist: one private account's data, and every
 * endpoint that reads or changes it, tried by a stranger and by an account the owner blocked.
 *
 * Each row must be refused (403 or 404, never 2xx or 5xx), and afterwards nothing may have changed.
 * An approved follower runs the read rows first, so a row can't pass just because its URL is wrong.
 */
describe('authorization matrix', () => {
  useTestDatabase({ scope: 'file' });
  const redis = useTestRedis();
  const media = createTestMediaProvider();
  const world = createWorld(redis, { mediaProvider: media.provider });
  const { as } = world;

  let owner: TestUser;
  let friend: TestUser;
  let stranger: TestUser;
  let blocked: TestUser;
  const ids = {
    post: '',
    comment: '',
    story: '',
    conversation: '',
    unusedMedia: '',
    strangersPost: '',
    pendingRequest: '',
  };

  beforeAll(async () => {
    owner = await world.user('owner', { isPrivate: true });
    friend = await world.user('friend');
    stranger = await world.user('stranger');
    blocked = await world.user('blocked');
    const requester = await world.user('requester');

    // friend and blocked are approved followers; then the owner blocks one of them.
    for (const follower of [friend, blocked]) {
      expect((await as(follower).put(`/users/${owner.id}/follow`)).status).toBeLessThan(300);
    }
    const requests = (await as(owner).get('/users/me/follow-requests')).body.data as {
      id: string;
    }[];
    for (const { id } of requests) {
      expect((await as(owner).post(`/users/me/follow-requests/${id}/accept`)).status).toBeLessThan(
        300,
      );
    }
    expect((await as(owner).put(`/users/${blocked.id}/block`)).status).toBeLessThan(300);
    // A request the owner hasn't answered yet: no one else may accept or decline it.
    await as(requester).put(`/users/${owner.id}/follow`);
    ids.pendingRequest = (
      (await as(owner).get('/users/me/follow-requests')).body.data as { id: string }[]
    )[0]!.id;

    ids.post = await world.post(owner, 'secret plans #hushhush');
    const comment = await as(owner).post(`/posts/${ids.post}/comments`, { text: 'note to self' });
    ids.comment = comment.body.data.id as string;
    const storyMedia = await uploadMedia(as(owner), media, { purpose: 'story' });
    ids.story = (await as(owner).post('/stories', { mediaId: storyMedia })).body.data.id as string;
    ids.unusedMedia = await uploadMedia(as(owner), media);
    const conversation = await as(friend).post('/conversations', { userId: owner.id });
    expect(conversation.status).toBeLessThan(300);
    ids.conversation = conversation.body.data.id as string;
    await as(friend).post(`/conversations/${ids.conversation}/messages`, {
      text: 'just us',
      clientId: randomUUID(),
    });
    ids.strangersPost = await world.post(stranger, 'a public post');
  });

  const reads = () => [
    `/users/${owner.id}/posts`,
    `/users/${owner.id}/followers`,
    `/users/${owner.id}/following`,
    `/users/${owner.id}/stories`,
    `/posts/${ids.post}`,
    `/posts/${ids.post}/likes`,
    `/posts/${ids.post}/comments`,
    `/comments/${ids.comment}/replies`,
  ];

  it('lets an approved follower read everything (proves the rows hit real routes)', async () => {
    for (const path of reads()) {
      const res = await as(friend).get(path);
      expect(res.status, `GET ${path}`).toBe(200);
    }
  });

  for (const who of ['stranger', 'blocked'] as const) {
    describe(`a ${who}`, () => {
      const actor = () => (who === 'stranger' ? stranger : blocked);

      it('cannot read the private account’s content', async () => {
        for (const path of [
          ...reads(),
          `/stories/${ids.story}/viewers`,
          `/conversations/${ids.conversation}`,
          `/conversations/${ids.conversation}/messages`,
        ]) {
          const res = await as(actor()).get(path);
          expect([403, 404], `GET ${path} → ${res.status}`).toContain(res.status);
        }
      });

      it('cannot change it, directly or through a side door', async () => {
        const writes: [string, () => ReturnType<ReturnType<typeof as>['get']>][] = [
          ['edit post', () => as(actor()).patch(`/posts/${ids.post}`, { text: 'pwned' })],
          ['delete post', () => as(actor()).delete(`/posts/${ids.post}`)],
          ['like', () => as(actor()).put(`/posts/${ids.post}/like`)],
          ['bookmark', () => as(actor()).put(`/posts/${ids.post}/bookmark`)],
          ['repost', () => as(actor()).put(`/posts/${ids.post}/repost`)],
          ['quote', () => as(actor()).post('/posts', { text: 'look', quotedPostId: ids.post })],
          ['comment', () => as(actor()).post(`/posts/${ids.post}/comments`, { text: 'hi' })],
          [
            // Reply to the private comment by way of the actor's own public post.
            'reply via another post',
            () =>
              as(actor()).post(`/posts/${ids.strangersPost}/comments`, {
                text: 'hi',
                parentId: ids.comment,
              }),
          ],
          ['delete comment', () => as(actor()).delete(`/comments/${ids.comment}`)],
          ['view story', () => as(actor()).post(`/stories/${ids.story}/views`)],
          ['delete story', () => as(actor()).delete(`/stories/${ids.story}`)],
          [
            'send message',
            () =>
              as(actor()).post(`/conversations/${ids.conversation}/messages`, {
                text: 'hi',
                clientId: randomUUID(),
              }),
          ],
          ['mark read', () => as(actor()).post(`/conversations/${ids.conversation}/read`)],
          [
            'attach their upload',
            () => as(actor()).post('/posts', { text: 'mine now', mediaIds: [ids.unusedMedia] }),
          ],
          [
            'use their upload for a story',
            () => as(actor()).post('/stories', { mediaId: ids.unusedMedia }),
          ],
          [
            'complete their upload',
            () =>
              as(actor()).post(`/media/uploads/${ids.unusedMedia}/complete`, { fileId: 'file_x' }),
          ],
          [
            'accept their follow request',
            () => as(actor()).post(`/users/me/follow-requests/${ids.pendingRequest}/accept`),
          ],
          [
            'decline their follow request',
            () => as(actor()).delete(`/users/me/follow-requests/${ids.pendingRequest}`),
          ],
        ];
        for (const [name, send] of writes) {
          const res = await send();
          // 400 is acceptable only where the input itself is what's wrong (e.g. a foreign parent).
          expect([400, 403, 404], `${name} → ${res.status}`).toContain(res.status);
        }

        const post = await PostModel.findById(ids.post).lean();
        expect(post).toMatchObject({ text: 'secret plans #hushhush', deletedAt: null });
        expect(post?.counts).toMatchObject({ likes: 0, comments: 1, reposts: 0 });
        expect(await PostModel.countDocuments({ sharedPostId: ids.post })).toBe(0);
        expect(await CommentModel.countDocuments({ parentId: ids.comment })).toBe(0);
        expect(await CommentModel.exists({ _id: ids.comment, deletedAt: null })).not.toBeNull();
        expect(await StoryModel.exists({ _id: ids.story })).not.toBeNull();
        expect(await MessageModel.countDocuments({ conversationId: ids.conversation })).toBe(1);
        expect(await PostModel.countDocuments({ 'media.mediaId': ids.unusedMedia })).toBe(0);
        const pending = (await as(owner).get('/users/me/follow-requests')).body.data as unknown[];
        expect(pending).toHaveLength(1);
      });

      it('cannot find it through search, hashtags or trending', async () => {
        const search = await as(actor()).get('/search/posts?q=secret%20plans');
        expect(search.body.data).toEqual([]);
        const tag = await as(actor()).get('/hashtags/hushhush/posts');
        expect(tag.body.data).toEqual([]);
        const trending = await as(actor()).get('/explore/trending');
        expect(trending.body.data).not.toContainEqual(expect.objectContaining({ tag: 'hushhush' }));
      });
    });
  }

  it('hides the owner’s profile entirely from the account they blocked', async () => {
    expect((await as(blocked).get(`/users/${owner.username}`)).status).toBe(404);
    expect((await as(stranger).get(`/users/${owner.username}`)).status).toBeLessThan(300);
  });
});
