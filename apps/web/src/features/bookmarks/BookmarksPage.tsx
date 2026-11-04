import { BookmarkIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBookmarks } from '../posts/api';
import { PostList } from '../posts/PostList';

export function BookmarksPage() {
  const bookmarks = useBookmarks();
  return (
    <>
      <PageHeader title="Bookmarks" subtitle="Only you can see what you save" />
      <PostList
        query={bookmarks}
        empty={
          <EmptyState
            icon={<BookmarkIcon />}
            title="Save posts for later"
            description="Bookmark posts to easily find them again."
          />
        }
      />
    </>
  );
}
