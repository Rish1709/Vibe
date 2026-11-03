import { MESSAGE_POLICIES, type MeDto, type MessagePolicy } from '@vibe/shared';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/Switch';
import { useUpdateSettings } from '../account/api';

const POLICY_LABELS: Record<MessagePolicy, string> = {
  everyone: 'Everyone',
  following: 'People I follow',
};

export function PrivacySettings({ me }: { me: MeDto }) {
  const update = useUpdateSettings();
  const save = (input: Parameters<typeof update.mutate>[0]) =>
    update.mutate(input, {
      onError: () => toast.error('Could not update settings. Change reverted.'),
    });

  return (
    <div className="flex flex-col gap-6">
      <Switch
        label="Private account"
        description="Only approved followers can see your posts and stories."
        checked={me.isPrivate}
        onChange={(isPrivate) => save({ isPrivate })}
      />
      <fieldset>
        <legend className="font-medium">Who can message you</legend>
        <div className="mt-2 flex flex-col gap-2">
          {MESSAGE_POLICIES.map((policy) => (
            <label key={policy} className="flex items-center gap-3 text-[15px]">
              <input
                type="radio"
                name="messagePolicy"
                className="size-4 accent-[var(--accent)]"
                checked={me.settings.messagePolicy === policy}
                onChange={() => save({ messagePolicy: policy })}
              />
              {POLICY_LABELS[policy]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
