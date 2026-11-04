import { NavLink, Outlet } from 'react-router';
import { Avatar } from '@/components/ui/Avatar';
import { Logo } from '@/components/ui/Logo';
import { useMe } from '@/features/account/api';
import { StoryViewer } from '@/features/stories/StoryViewer';
import { navItems } from '../navigation';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'flex items-center gap-4 rounded-full px-4 py-3 text-[15px] transition-colors hover:bg-surface-hover',
    isActive ? 'font-semibold text-text' : 'text-muted',
  ].join(' ');

/**
 * Three responsive tiers: a bottom tab bar on phones, an icon rail on tablets,
 * and a labelled sidebar on desktop. The content column stays a readable width throughout.
 * Rendered only behind RequireOnboarded, so the account is always loaded here.
 */
export function AppLayout() {
  const { data: me } = useMe();
  if (!me?.username) return null;
  const items = navItems(me.username);

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl">
      <aside className="sticky top-0 hidden h-dvh shrink-0 flex-col gap-6 border-r border-border px-3 py-6 sm:flex lg:w-64">
        <div className="px-3">
          <span className="hidden lg:inline">
            <Logo />
          </span>
          <span className="lg:hidden">
            <Logo withWordmark={false} />
          </span>
        </div>
        <nav aria-label="Primary" className="flex flex-col gap-1">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end className={linkClass}>
              <Icon className="size-6 shrink-0" />
              <span className="hidden lg:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <NavLink
          to={`/${me.username}`}
          className="mt-auto flex items-center gap-3 rounded-full p-2 hover:bg-surface-hover"
        >
          <Avatar src={me.avatarUrl} name={me.displayName} />
          <span className="hidden min-w-0 lg:block">
            <span className="block truncate text-sm font-semibold">{me.displayName}</span>
            <span className="block truncate text-sm text-muted">@{me.username}</span>
          </span>
        </NavLink>
      </aside>

      <main className="min-w-0 flex-1 pb-16 sm:pb-0">
        <div className="mx-auto min-h-dvh max-w-2xl border-border sm:border-r">
          <Outlet />
        </div>
      </main>

      <StoryViewer />

      <nav
        aria-label="Primary mobile"
        className="fixed inset-x-0 bottom-0 z-10 flex justify-around border-t border-border bg-bg/90 py-2 backdrop-blur sm:hidden"
      >
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end
            aria-label={label}
            className={({ isActive }) => `p-2 ${isActive ? 'text-text' : 'text-muted'}`}
          >
            <Icon className="size-6" />
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
