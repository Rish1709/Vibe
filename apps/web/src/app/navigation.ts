import type { ComponentType, SVGProps } from 'react';
import { BookmarkIcon, HomeIcon, SearchIcon, SettingsIcon, UserIcon } from '@/components/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

/** Primary navigation. Each feature adds its entry here when its screen ships. */
export function navItems(username: string): NavItem[] {
  return [
    { to: '/', label: 'Home', icon: HomeIcon },
    { to: '/search', label: 'Search', icon: SearchIcon },
    { to: `/${username}`, label: 'Profile', icon: UserIcon },
    { to: '/bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
}
