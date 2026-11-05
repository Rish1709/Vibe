import type { ComponentType, SVGProps } from 'react';
import {
  BellIcon,
  BookmarkIcon,
  HomeIcon,
  MessageIcon,
  SearchIcon,
  SettingsIcon,
  UserIcon,
} from '@/components/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Which unread count to show on the item. */
  badge?: 'messages' | 'notifications';
}

/** Primary navigation. Each feature adds its entry here when its screen ships. */
export function navItems(username: string): NavItem[] {
  return [
    { to: '/', label: 'Home', icon: HomeIcon },
    { to: '/explore', label: 'Explore', icon: SearchIcon },
    { to: '/notifications', label: 'Notifications', icon: BellIcon, badge: 'notifications' },
    { to: '/messages', label: 'Messages', icon: MessageIcon, badge: 'messages' },
    { to: `/${username}`, label: 'Profile', icon: UserIcon },
    { to: '/bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];
}
