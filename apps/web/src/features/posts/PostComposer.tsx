import { POST_TEXT_MAX, type MeDto, type PostDto } from '@vibe/shared';
import { useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ApiError } from '@/lib/apiClient';
import { useCreatePost } from './api';
import { QuotedPost } from './QuotedPost';

interface PostComposerProps {
  me: MeDto;
  quoted?: PostDto;
  placeholder?: string;
  autoFocus?: boolean;
  onPosted?: (post: PostDto) => void;
}

export function PostComposer({
  me,
  quoted,
  placeholder = "What's happening?",
  autoFocus,
  onPosted,
}: PostComposerProps) {
  const [text, setText] = useState('');
  const create = useCreatePost();
  const remaining = POST_TEXT_MAX - text.length;
  const canPost = text.trim().length > 0 && remaining >= 0 && !create.isPending;

  const submit = () => {
    if (!canPost) return;
    create.mutate(
      { text: text.trim(), ...(quoted && { quotedPostId: quoted.id }) },
      {
        onSuccess: (post) => {
          setText('');
          toast.success(quoted ? 'Quote posted' : 'Posted');
          onPosted?.(post);
        },
        onError: (error) =>
          toast.error(error instanceof ApiError ? error.message : 'Could not post'),
      },
    );
  };

  return (
    <div className="flex gap-3 border-b border-border px-4 py-3">
      <Avatar src={me.avatarUrl} name={me.displayName} />
      <div className="min-w-0 flex-1">
        <label htmlFor="composer" className="sr-only">
          {quoted ? 'Add a comment' : 'New post'}
        </label>
        <textarea
          id="composer"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={quoted ? 2 : 3}
          className="w-full resize-none bg-transparent py-2 text-lg outline-none placeholder:text-muted"
        />
        {quoted && <QuotedPost post={quoted} />}
        <div className="mt-2 flex items-center justify-end gap-3">
          <span
            aria-live="polite"
            className={`text-sm ${remaining < 0 ? 'text-danger' : remaining < 40 ? 'text-amber-500' : 'text-muted'}`}
          >
            {remaining}
          </span>
          <Button onClick={submit} disabled={!canPost} loading={create.isPending}>
            Post
          </Button>
        </div>
      </div>
    </div>
  );
}
