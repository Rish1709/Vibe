import { zodResolver } from '@hookform/resolvers/zod';
import {
  BIO_MAX,
  bioSchema,
  displayNameSchema,
  usernameSchema,
  websiteSchema,
  type MeDto,
  type UpdateProfileInput,
} from '@vibe/shared';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/Button';
import { TextArea, TextField } from '@/components/ui/Field';
import { ApiError } from '@/lib/apiClient';
import { useUpdateProfile, useUsernameAvailability } from '../account/api';
import { UsernameStatus } from '../account/UsernameStatus';

/** The full form; only fields the user actually changed are sent (the API takes partial updates). */
const profileFormSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  bio: bioSchema,
  website: z.union([websiteSchema, z.literal('')]),
});
type FormInput = z.input<typeof profileFormSchema>;
type FormOutput = z.output<typeof profileFormSchema>;

export function ProfileForm({ me }: { me: MeDto }) {
  const update = useUpdateProfile();
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, dirtyFields, isDirty },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      username: me.username ?? '',
      displayName: me.displayName,
      bio: me.bio,
      website: me.website ?? '',
    },
    mode: 'onTouched',
  });
  const [username, bio] = useWatch({ control, name: ['username', 'bio'] });
  const availability = useUsernameAvailability(username, me.username);

  const onSubmit = handleSubmit((values) => {
    const changes: UpdateProfileInput = {};
    if (dirtyFields.username) changes.username = values.username;
    if (dirtyFields.displayName) changes.displayName = values.displayName;
    if (dirtyFields.bio) changes.bio = values.bio;
    if (dirtyFields.website) changes.website = values.website;

    update.mutate(changes, {
      onSuccess: (updated) => {
        reset({
          username: updated.username ?? '',
          displayName: updated.displayName,
          bio: updated.bio,
          website: updated.website ?? '',
        });
        toast.success('Profile saved');
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'USERNAME_TAKEN') {
          setError('username', { message: error.message });
        } else {
          toast.error(error instanceof ApiError ? error.message : 'Could not save your profile');
        }
      },
    });
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      <TextField
        label="Display name"
        error={errors.displayName?.message}
        {...register('displayName')}
      />
      <TextField
        label="Username"
        prefix="@"
        autoCapitalize="none"
        spellCheck={false}
        error={errors.username?.message}
        hint={<UsernameStatus state={availability} />}
        {...register('username')}
      />
      <TextArea
        label="Bio"
        maxLength={BIO_MAX}
        error={errors.bio?.message}
        hint={`${bio.length}/${BIO_MAX}`}
        {...register('bio')}
      />
      <TextField
        label="Website"
        type="url"
        placeholder="https://"
        error={errors.website?.message}
        {...register('website')}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          loading={update.isPending}
          disabled={!isDirty || availability.status === 'unavailable'}
        >
          Save
        </Button>
      </div>
    </form>
  );
}
