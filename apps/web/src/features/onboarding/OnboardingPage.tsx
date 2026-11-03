import { zodResolver } from '@hookform/resolvers/zod';
import { onboardingSchema, type MeDto } from '@vibe/shared';
import { useForm, useWatch } from 'react-hook-form';
import { Navigate, useNavigate } from 'react-router';
import { toast } from 'sonner';
import type { z } from 'zod';
import { FullPageSpinner } from '@/app/guards';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { TextField } from '@/components/ui/Field';
import { Logo } from '@/components/ui/Logo';
import { ApiError } from '@/lib/apiClient';
import { useCompleteOnboarding, useMe, useUsernameAvailability } from '../account/api';
import { UsernameStatus } from '../account/UsernameStatus';

type FormInput = z.input<typeof onboardingSchema>;
type FormOutput = z.output<typeof onboardingSchema>;

function OnboardingForm({ me }: { me: MeDto }) {
  const navigate = useNavigate();
  const onboarding = useCompleteOnboarding();
  const {
    register,
    handleSubmit,
    control,
    setError,
    formState: { errors },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: { username: '', displayName: me.displayName },
    mode: 'onTouched',
  });
  const availability = useUsernameAvailability(useWatch({ control, name: 'username' }), null);

  const onSubmit = handleSubmit((values) => {
    onboarding.mutate(values, {
      onSuccess: () => {
        toast.success('Welcome to Vibe!');
        void navigate('/', { replace: true });
      },
      onError: (error) => {
        // The availability check is advisory; someone may have claimed the name since.
        if (error instanceof ApiError && error.code === 'USERNAME_TAKEN') {
          setError('username', { message: error.message });
        } else {
          toast.error(error instanceof ApiError ? error.message : 'Could not finish setup');
        }
      },
    });
  });

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
      <TextField
        label="Username"
        prefix="@"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus
        error={errors.username?.message}
        hint={<UsernameStatus state={availability} />}
        {...register('username')}
      />
      <TextField
        label="Display name"
        autoComplete="name"
        error={errors.displayName?.message}
        {...register('displayName')}
      />
      <Button
        type="submit"
        loading={onboarding.isPending}
        disabled={availability.status === 'unavailable'}
        className="mt-2 w-full py-3"
      >
        Continue
      </Button>
    </form>
  );
}

export function OnboardingPage() {
  const me = useMe();
  if (me.isPending) return <FullPageSpinner />;
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  if (me.data.onboarded) return <Navigate to="/" replace />;

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo />
        <h1 className="mt-8 text-2xl font-bold">Pick your username</h1>
        <p className="mt-1 mb-8 text-muted">It's how people find you. You can change it later.</p>
        <OnboardingForm me={me.data} />
      </div>
    </div>
  );
}
