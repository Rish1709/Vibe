import type { RouteObject } from 'react-router';
import { SignInPage, SignUpPage } from '@/features/auth/AuthPage';
import { BookmarksPage } from '@/features/bookmarks/BookmarksPage';
import { PostDetailPage } from '@/features/posts/PostDetailPage';
import { FollowListPage } from '@/features/relationships/FollowListPage';
import { HomePage } from '@/features/feed/HomePage';
import { OnboardingPage } from '@/features/onboarding/OnboardingPage';
import { ProfilePage } from '@/features/profile/ProfilePage';
import { SearchPage } from '@/features/search/SearchPage';
import { ConversationPage } from '@/features/messages/ConversationPage';
import { MessagesPage } from '@/features/messages/MessagesPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { RequireAuth, RequireOnboarded } from './guards';
import { AppLayout } from './layouts/AppLayout';
import { NotFoundPage } from './NotFoundPage';
import { RootLayout } from './RootLayout';

/**
 * Static segments rank above `:username`, which is why reserved usernames (packages/shared)
 * must include every top-level route.
 */
export const appRoutes: RouteObject[] = [
  { path: '/sign-in/*', element: <SignInPage /> },
  { path: '/sign-up/*', element: <SignUpPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/onboarding', element: <OnboardingPage /> },
      {
        element: <RequireOnboarded />,
        children: [
          {
            element: <AppLayout />,
            children: [
              { index: true, element: <HomePage /> },
              { path: 'settings', element: <SettingsPage /> },
              { path: 'bookmarks', element: <BookmarksPage /> },
              { path: 'search', element: <SearchPage /> },
              { path: 'messages', element: <MessagesPage /> },
              { path: 'messages/:conversationId', element: <ConversationPage /> },
              { path: 'notifications', element: <NotificationsPage /> },
              { path: 'p/:postId', element: <PostDetailPage /> },
              { path: ':username', element: <ProfilePage /> },
              { path: ':username/followers', element: <FollowListPage kind="followers" /> },
              { path: ':username/following', element: <FollowListPage kind="following" /> },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];

export const routes: RouteObject[] = [{ element: <RootLayout />, children: appRoutes }];
