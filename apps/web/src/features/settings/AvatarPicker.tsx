import type { MeDto } from '@vibe/shared';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ApiError } from '@/lib/apiClient';
import { uploadMedia } from '@/lib/media';
import { useUpdateProfile } from '../account/api';

export function AvatarPicker({ me }: { me: MeDto }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const update = useUpdateProfile();

  const change = async (file: File) => {
    try {
      setProgress(0);
      const media = await uploadMedia(file, 'avatar', setProgress);
      await update.mutateAsync({ avatarMediaId: media.id });
      toast.success('Profile photo updated');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update your photo');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Avatar src={me.avatarUrl} name={me.displayName} size="lg" />
      <div className="flex flex-col gap-2">
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void change(file);
            event.target.value = '';
          }}
        />
        <Button
          variant="secondary"
          loading={progress !== null}
          onClick={() => input.current?.click()}
        >
          {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Change photo'}
        </Button>
        {me.avatarUrl && (
          <Button
            variant="ghost"
            disabled={update.isPending}
            onClick={() => update.mutate({ avatarMediaId: null })}
          >
            Remove photo
          </Button>
        )}
      </div>
    </div>
  );
}
