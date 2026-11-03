import { SignIn, SignUp, useAuth } from '@clerk/react';
import { Navigate } from 'react-router';
import { Logo } from '@/components/ui/Logo';

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo />
        <p className="max-w-xs text-muted">Share moments, follow friends, and talk in real time.</p>
      </div>
      {children}
    </div>
  );
}

export function SignInPage() {
  const { isSignedIn } = useAuth();
  if (isSignedIn) return <Navigate to="/" replace />;
  return (
    <AuthShell>
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/" />
    </AuthShell>
  );
}

export function SignUpPage() {
  const { isSignedIn } = useAuth();
  if (isSignedIn) return <Navigate to="/" replace />;
  return (
    <AuthShell>
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/onboarding"
      />
    </AuthShell>
  );
}
