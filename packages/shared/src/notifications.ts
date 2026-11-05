import type { UserSummaryDto } from './social.js';

export const NOTIFICATION_TYPES = [
  'like',
  'comment',
  'reply',
  'follow',
  'follow_request',
  'follow_accept',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationDto {
  id: string;
  type: NotificationType;
  actor: UserSummaryDto;
  /** The post liked or commented on. */
  post: { id: string; text: string; thumbnailUrl: string | null } | null;
  comment: { id: string; text: string } | null;
  read: boolean;
  createdAt: string;
}
