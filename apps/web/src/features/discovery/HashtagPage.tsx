import { useParams } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { PostList } from '../posts/PostList';
import { useHashtagPosts } from './api';

export function HashtagPage() {
  const tag = (useParams().tag ?? '').toLowerCase();
  const posts = useHashtagPosts(tag);
  return (
    <>
      <PageHeader title={`#${tag}`} subtitle="Posts you can see, newest first" />
      <PostList
        query={posts}
        empty={
          <EmptyState title={`No posts with #${tag} yet`} description="Be the first to use it." />
        }
      />
    </>
  );
}
