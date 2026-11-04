import type { Relationship } from '../modules/relationships/relationship.service.js';

/**
 * The single source of truth for who may see and touch what. Every module (profiles, posts,
 * comments, likes, and later feed, stories and chat) calls these instead of re-implementing the rules.
 * Pure functions of already-loaded data, so they are trivially testable and cost no queries.
 */

interface Author {
  isPrivate: boolean;
}

/**
 * Someone who blocked the viewer disappears entirely (their profile is a 404), mirroring how
 * mainstream apps avoid revealing a block. The viewer can still open profiles they blocked, to unblock.
 */
export function canSeeProfile(rel: Relationship): boolean {
  return rel.isSelf || !rel.blockingViewer;
}

/** Posts, comments, follower lists: public accounts to everyone not blocked, private ones to approved followers. */
export function canViewContent(rel: Relationship, author: Author): boolean {
  if (rel.isSelf) return true;
  if (rel.blockingViewer || rel.blockedByViewer) return false;
  return !author.isPrivate || rel.following === 'active';
}

/** Liking, commenting and bookmarking require being able to see the content. */
export const canInteract = canViewContent;

/**
 * Resharing additionally requires a public author: a repost would show a private account's
 * post to the reposter's audience, who never got the author's approval.
 */
export function canReshare(rel: Relationship, author: Author): boolean {
  return canViewContent(rel, author) && !author.isPrivate;
}

/** A new follow (or request) is impossible across a block in either direction, and with oneself. */
export function canFollow(rel: Relationship): boolean {
  return !rel.isSelf && !rel.blockingViewer && !rel.blockedByViewer;
}
