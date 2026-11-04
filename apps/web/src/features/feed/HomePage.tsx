import { Link } from 'react-router';
import { SparkIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useMe } from '../account/api';
import { PostComposer } from '../posts/PostComposer';

export function HomePage() {
  const { data: me } = useMe();
  return (
    <>
      <PageHeader title="Home" />
      {me && <PostComposer me={me} />}
      <EmptyState
        icon={<SparkIcon />}
        title="Your feed is quiet"
        description="Posts from people you follow will show up here."
        action={
          me?.username && (
            <Link
              to={`/${me.username}`}
              className="text-sm font-semibold text-accent hover:underline"
            >
              See your posts
            </Link>
          )
        }
      />
    </>
  );
}
