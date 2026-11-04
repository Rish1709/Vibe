import { SparkIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMe } from '../account/api';
import { useFeed } from '../posts/api';
import { PostComposer } from '../posts/PostComposer';
import { PostList } from '../posts/PostList';

export function HomePage() {
  const { data: me } = useMe();
  const feed = useFeed();
  return (
    <>
      <PageHeader title="Home" />
      {me && <PostComposer me={me} />}
      <PostList
        query={feed}
        empty={
          <EmptyState
            icon={<SparkIcon />}
            title="Your feed is quiet"
            description="Follow people to see their posts here. Your own posts show up here too."
          />
        }
      />
    </>
  );
}
