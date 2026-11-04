import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { PostDto } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import type { Page } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';
import { makePost } from '@/test/utils';
import { removePostEverywhere, updatePostEverywhere } from './cache';

const like = (post: PostDto): PostDto => ({ ...post, viewer: { ...post.viewer, liked: true } });

describe('post cache helpers', () => {
  it('patches a post in lists, detail queries and inside reposts', () => {
    const client = new QueryClient();
    const target = makePost({ text: 'target' });
    const repost = makePost({ kind: 'repost', sharedPost: target });
    const list: InfiniteData<Page<PostDto>> = {
      pages: [
        { items: [makePost(), repost], nextCursor: 'c' },
        { items: [target], nextCursor: null },
      ],
      pageParams: [null, 'c'],
    };
    client.setQueryData(queryKeys.userPosts('u1'), list);
    client.setQueryData(queryKeys.post(target.id), target);

    updatePostEverywhere(client, target.id, like);

    const updated = client.getQueryData<InfiniteData<Page<PostDto>>>(queryKeys.userPosts('u1'));
    expect(updated?.pages[0]?.items[1]?.sharedPost?.viewer.liked).toBe(true);
    expect(updated?.pages[1]?.items[0]?.viewer.liked).toBe(true);
    expect(updated?.pages[0]?.items[0]?.viewer.liked).toBe(false);
    expect(client.getQueryData<PostDto>(queryKeys.post(target.id))?.viewer.liked).toBe(true);
  });

  it('removes a deleted post and reposts of it from every list', () => {
    const client = new QueryClient();
    const target = makePost();
    const keep = makePost();
    client.setQueryData(queryKeys.bookmarks, {
      pages: [
        {
          items: [target, makePost({ kind: 'repost', sharedPost: target }), keep],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });

    removePostEverywhere(client, target.id);

    const items = client.getQueryData<InfiniteData<Page<PostDto>>>(queryKeys.bookmarks)?.pages[0]
      ?.items;
    expect(items?.map((post) => post.id)).toEqual([keep.id]);
  });
});
