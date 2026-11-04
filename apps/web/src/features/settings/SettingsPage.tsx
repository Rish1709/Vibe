import { useClerk } from '@clerk/react';
import type { ReactNode } from 'react';
import { LogoutIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useMe } from '../account/api';
import { BlockedAccounts, FollowRequests } from './ConnectionSettings';
import { PrivacySettings } from './PrivacySettings';
import { ProfileForm } from './ProfileForm';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-6">
      <h2 className="mb-5 text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const me = useMe();
  const { signOut } = useClerk();

  if (me.isPending) {
    return (
      <>
        <PageHeader title="Settings" />
        <div className="flex flex-col gap-4 p-4" aria-busy="true">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-24" />
        </div>
      </>
    );
  }
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;

  return (
    <>
      <PageHeader title="Settings" />
      <Section title="Profile">
        <ProfileForm me={me.data} />
      </Section>
      <Section title="Privacy">
        <PrivacySettings me={me.data} />
      </Section>
      <Section title="Follow requests">
        <FollowRequests />
      </Section>
      <Section title="Blocked accounts">
        <BlockedAccounts />
      </Section>
      <Section title="Account">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted">Signed in as</p>
            <p className="font-medium">{me.data.email ?? 'Unknown email'}</p>
          </div>
          <Button variant="danger" onClick={() => void signOut()}>
            <LogoutIcon className="size-4" /> Sign out
          </Button>
        </div>
      </Section>
    </>
  );
}
