import { useAuth } from '@clerk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  usernameSchema,
  type MeDto,
  type OnboardingInput,
  type UpdateProfileInput,
  type UpdateSettingsInput,
  type UsernameAvailabilityDto,
} from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { queryKeys } from '@/lib/queryKeys';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

const USERNAME_CHECK_DEBOUNCE_MS = 400;

export function useMe() {
  const { isSignedIn } = useAuth();
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async ({ signal }) => (await apiRequest<MeDto>('/api/v1/users/me', { signal })).data,
    enabled: isSignedIn === true,
  });
}

/** Writes the server's returned account into the cache, so every consumer re-renders with it. */
function useAccountMutation<TInput>(path: string, method: 'POST' | 'PATCH') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TInput) =>
      (await apiRequest<MeDto>(path, { method, body: input })).data,
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      if (me.username)
        void queryClient.invalidateQueries({ queryKey: queryKeys.profile(me.username) });
    },
  });
}

export const useCompleteOnboarding = () =>
  useAccountMutation<OnboardingInput>('/api/v1/users/me/onboarding', 'POST');

export const useUpdateProfile = () =>
  useAccountMutation<UpdateProfileInput>('/api/v1/users/me', 'PATCH');

/**
 * Optimistic: the toggle flips immediately, and the previous value is restored if the server
 * rejects the change. Settings are low-risk and the user expects instant feedback from a switch.
 */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateSettingsInput) =>
      (await apiRequest<MeDto>('/api/v1/users/me/settings', { method: 'PATCH', body: input })).data,
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.me });
      const previous = queryClient.getQueryData<MeDto>(queryKeys.me);
      if (previous) {
        queryClient.setQueryData<MeDto>(queryKeys.me, {
          ...previous,
          isPrivate: input.isPrivate ?? previous.isPrivate,
          settings: { messagePolicy: input.messagePolicy ?? previous.settings.messagePolicy },
        });
      }
      return { previous };
    },
    onError: (_err, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.me, context.previous);
    },
    onSuccess: (me) => queryClient.setQueryData(queryKeys.me, me),
  });
}

export type AvailabilityState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available' }
  | { status: 'unavailable'; reason: string };

/**
 * Debounced server check, skipped entirely for names that fail client-side validation
 * (the form already shows that error) or that equal the user's current name.
 */
export function useUsernameAvailability(
  raw: string,
  currentUsername: string | null,
): AvailabilityState {
  const typed = raw.trim().toLowerCase();
  const debounced = useDebouncedValue(typed, USERNAME_CHECK_DEBOUNCE_MS);
  const shouldCheck = (name: string) =>
    name !== currentUsername && usernameSchema.safeParse(name).success;

  const query = useQuery({
    queryKey: queryKeys.usernameAvailability(debounced),
    queryFn: async ({ signal }) =>
      (
        await apiRequest<UsernameAvailabilityDto>(
          `/api/v1/users/username-availability?username=${encodeURIComponent(debounced)}`,
          { signal },
        )
      ).data,
    enabled: shouldCheck(debounced),
    staleTime: 10_000,
  });

  if (!shouldCheck(typed)) return { status: 'idle' };
  // Still typing, or the request for the settled value is in flight.
  if (typed !== debounced || query.isPending) return { status: 'checking' };
  if (!query.data) return { status: 'idle' };
  return query.data.available
    ? { status: 'available' }
    : { status: 'unavailable', reason: query.data.reason ?? 'That username is taken' };
}
