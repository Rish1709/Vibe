import type {
  ConversationDto,
  MessageDto,
  PageMeta,
  SendMessageInput,
  UserSummaryDto,
} from '@vibe/shared';
import { Types } from 'mongoose';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { canMessage, canSeeProfile } from '../../policies/visibility.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import {
  getRelationship,
  getRelationships,
  type Relationship,
} from '../relationships/relationship.service.js';
import { findUserSummaries, requireActiveUser } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import {
  ConversationModel,
  conversationKey,
  MessageModel,
  type ConversationRecord,
  type MessageRecord,
} from './message.models.js';

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

const oid = (id: string) => new Types.ObjectId(id);
const hex = (id: Types.ObjectId) => id.toHexString();

function otherOf(conversation: Pick<ConversationRecord, 'participants'>, userId: string): string {
  const other = conversation.participants.find((id) => !id.equals(userId));
  if (!other) throw Errors.internal(new Error('Conversation without a second participant'));
  return hex(other);
}

export function toMessageDto(message: MessageRecord): MessageDto {
  return {
    id: hex(message._id),
    conversationId: hex(message.conversationId),
    senderId: hex(message.senderId),
    text: message.text,
    clientId: message.clientId,
    createdAt: message.createdAt.toISOString(),
  };
}

function toConversationDto(
  conversation: ConversationRecord,
  viewerId: string,
  user: UserSummaryDto,
  canSend?: boolean,
): ConversationDto {
  const me = conversation.members.find((member) => member.userId.equals(viewerId));
  const other = conversation.members.find((member) => !member.userId.equals(viewerId));
  const last = conversation.lastMessage;
  return {
    id: hex(conversation._id),
    user,
    lastMessage: last
      ? {
          id: hex(last.id),
          senderId: hex(last.senderId),
          text: last.text,
          createdAt: last.createdAt.toISOString(),
        }
      : null,
    unread: Math.max(0, me?.unread ?? 0),
    otherLastReadAt: other?.lastReadAt?.toISOString() ?? null,
    ...(canSend !== undefined && { canSend }),
  };
}

export type MessageService = ReturnType<typeof createMessageService>;

export function createMessageService({ realtime }: { realtime: RealtimePublisher }) {
  /** Loads a conversation the viewer belongs to, or 404 (never revealing that it exists). */
  async function loadOwn(viewer: AuthUser, conversationId: string): Promise<ConversationRecord> {
    const conversation = await ConversationModel.findOne({
      _id: conversationId,
      participants: oid(viewer.id),
    }).lean<ConversationRecord>();
    if (!conversation) throw Errors.notFound('Conversation not found');
    return conversation;
  }

  /** Someone who blocked the viewer disappears, as everywhere else. */
  function assertVisible(rel: Relationship) {
    if (!canSeeProfile(rel)) throw Errors.notFound('Conversation not found');
  }

  async function mayMessage(viewer: AuthUser, conversationId: Types.ObjectId, otherId: string) {
    const [target, rel] = await Promise.all([
      requireActiveUser(otherId),
      getRelationship(viewer.id, otherId),
    ]);
    if (canMessage(rel, target)) return { allowed: true, rel };
    // The reply exception: if they wrote here first, the viewer may answer whatever their policy.
    const wroteFirst = await MessageModel.exists({ conversationId, senderId: oid(otherId) });
    return { allowed: canMessage(rel, target, { recipientWroteFirst: wroteFirst !== null }), rel };
  }

  async function summaryOf(userId: string): Promise<UserSummaryDto> {
    const summary = (await findUserSummaries([userId])).get(userId);
    if (!summary) throw Errors.notFound('Conversation not found');
    return summary;
  }

  return {
    /** Get-or-create the one-to-one conversation with `targetId`. Safe under concurrent calls. */
    async open(viewer: AuthUser, targetId: string): Promise<ConversationDto> {
      if (targetId === viewer.id) throw Errors.badRequest("You can't message yourself");
      await requireActiveUser(targetId);
      const rel = await getRelationship(viewer.id, targetId);
      if (!canSeeProfile(rel)) throw Errors.notFound('User not found');

      const key = conversationKey(viewer.id, targetId);
      const insert = {
        $setOnInsert: {
          participants: [oid(viewer.id), oid(targetId)],
          members: [{ userId: oid(viewer.id) }, { userId: oid(targetId) }],
        },
      };
      let conversation: ConversationRecord | null;
      try {
        conversation = await ConversationModel.findOneAndUpdate({ key }, insert, {
          upsert: true,
          returnDocument: 'after',
        }).lean<ConversationRecord>();
      } catch (err) {
        // Two concurrent upserts can both miss and both insert; the unique key rejects one.
        if (!isDuplicateKeyError(err)) throw err;
        conversation = await ConversationModel.findOne({ key }).lean<ConversationRecord>();
      }
      if (!conversation) throw Errors.internal(new Error('Conversation upsert returned nothing'));
      const { allowed } = await mayMessage(viewer, conversation._id, targetId);
      return toConversationDto(conversation, viewer.id, await summaryOf(targetId), allowed);
    },

    async get(viewer: AuthUser, conversationId: string): Promise<ConversationDto> {
      const conversation = await loadOwn(viewer, conversationId);
      const otherId = otherOf(conversation, viewer.id);
      const { allowed, rel } = await mayMessage(viewer, conversation._id, otherId);
      assertVisible(rel);
      return toConversationDto(conversation, viewer.id, await summaryOf(otherId), allowed);
    },

    /** The inbox: conversations with at least one message, most recent activity first. */
    async list(
      viewer: AuthUser,
      { cursor, limit }: PageInput,
    ): Promise<{ items: ConversationDto[]; meta: PageMeta }> {
      const rows = await ConversationModel.find({
        participants: oid(viewer.id),
        lastMessageAt: { $ne: null },
        ...keysetFilter(cursor, 'desc', 'lastMessageAt'),
      })
        .sort(keysetSort('desc', 'lastMessageAt'))
        .limit(limit + 1)
        .lean<(ConversationRecord & { lastMessageAt: Date })[]>();
      const { items, meta } = keysetPage(rows, limit, (row) => row.lastMessageAt);

      const otherIds = items.map((conversation) => otherOf(conversation, viewer.id));
      const [summaries, relationships] = await Promise.all([
        findUserSummaries(otherIds),
        getRelationships(viewer.id, otherIds),
      ]);
      const dtos = items.flatMap((conversation, index) => {
        const otherId = otherIds[index] ?? '';
        const summary = summaries.get(otherId);
        const rel = relationships.get(otherId);
        // Deleted accounts and people who blocked the viewer drop out of the inbox.
        if (!summary || !rel || !canSeeProfile(rel)) return [];
        return [toConversationDto(conversation, viewer.id, summary)];
      });
      return { items: dtos, meta };
    },

    /** Newest first; the client renders them bottom-up and loads older pages as it scrolls up. */
    async messages(
      viewer: AuthUser,
      conversationId: string,
      { cursor, limit }: PageInput,
    ): Promise<{ items: MessageDto[]; meta: PageMeta }> {
      const conversation = await loadOwn(viewer, conversationId);
      assertVisible(await getRelationship(viewer.id, otherOf(conversation, viewer.id)));
      const rows = await MessageModel.find({
        conversationId: conversation._id,
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<MessageRecord[]>();
      const { items, meta } = keysetPage(rows, limit);
      return { items: items.map(toMessageDto), meta };
    },

    /**
     * Idempotent per clientId: a retry returns the stored message and repeats no side effects.
     * The message is persisted first and pushed second; a push that never arrives is recovered by
     * the next read, so delivery can be best effort.
     */
    async send(
      viewer: AuthUser,
      conversationId: string,
      input: SendMessageInput,
    ): Promise<{ message: MessageDto; created: boolean }> {
      const conversation = await loadOwn(viewer, conversationId);
      const existing = await MessageModel.findOne({
        senderId: oid(viewer.id),
        clientId: input.clientId,
      }).lean<MessageRecord>();
      if (existing) return replay(existing, conversation);

      const otherId = otherOf(conversation, viewer.id);
      const { allowed, rel } = await mayMessage(viewer, conversation._id, otherId);
      assertVisible(rel);
      if (!allowed) throw Errors.forbidden("You can't message this account");

      let message: MessageRecord;
      try {
        message = (
          await MessageModel.create({
            conversationId: conversation._id,
            senderId: viewer.id,
            text: input.text,
            clientId: input.clientId,
          })
        ).toObject<MessageRecord>();
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // A concurrent retry won the insert: answer with its message.
        const winner = await MessageModel.findOne({
          senderId: oid(viewer.id),
          clientId: input.clientId,
        }).lean<MessageRecord>();
        if (!winner) throw err;
        return replay(winner, conversation);
      }

      const me = oid(viewer.id);
      const other = oid(otherId);
      await Promise.all([
        // Always applied: the recipient has one more unread; sending implies the sender has read.
        ConversationModel.updateOne(
          { _id: conversation._id },
          {
            $inc: { 'members.$[other].unread': 1 },
            $set: { 'members.$[me].unread': 0, 'members.$[me].lastReadAt': message.createdAt },
          },
          { arrayFilters: [{ 'other.userId': other }, { 'me.userId': me }] },
        ),
        // Conditional: two concurrent sends must not leave the older one as the inbox preview.
        ConversationModel.updateOne(
          {
            _id: conversation._id,
            $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: message.createdAt } }],
          },
          {
            $set: {
              lastMessageAt: message.createdAt,
              lastMessage: {
                id: message._id,
                senderId: message.senderId,
                text: message.text,
                createdAt: message.createdAt,
              },
            },
          },
        ),
      ]);

      const dto = toMessageDto(message);
      realtime.toUser(otherId, 'message:new', dto);
      // The sender's other tabs and devices show it too.
      realtime.toUser(viewer.id, 'message:new', dto);
      return { message: dto, created: true };
    },

    /** Clears the viewer's unread count and tells the other participant ("Seen"). Idempotent. */
    async markRead(viewer: AuthUser, conversationId: string): Promise<void> {
      const conversation = await loadOwn(viewer, conversationId);
      const readAt = new Date();
      await ConversationModel.updateOne(
        { _id: conversation._id },
        { $set: { 'members.$[me].unread': 0, 'members.$[me].lastReadAt': readAt } },
        { arrayFilters: [{ 'me.userId': oid(viewer.id) }] },
      );
      const event = {
        conversationId,
        userId: viewer.id,
        readAt: readAt.toISOString(),
      };
      realtime.toUser(otherOf(conversation, viewer.id), 'conversation:read', event);
      // The viewer's other tabs clear their unread badge.
      realtime.toUser(viewer.id, 'conversation:read', event);
    },

    /** Conversations with unread messages (the inbox badge). */
    async unreadConversations(viewer: AuthUser): Promise<number> {
      return ConversationModel.countDocuments({
        members: { $elemMatch: { userId: oid(viewer.id), unread: { $gt: 0 } } },
      });
    },

    /** For the socket gateway: the other participant if `userId` is a member, else null. */
    async otherParticipant(conversationId: string, userId: string): Promise<string | null> {
      const conversation = await ConversationModel.findOne(
        { _id: conversationId, participants: oid(userId) },
        { participants: 1 },
      ).lean<Pick<ConversationRecord, 'participants'>>();
      return conversation ? otherOf(conversation, userId) : null;
    },
  };

  function replay(
    message: MessageRecord,
    conversation: Pick<ConversationRecord, '_id'>,
  ): { message: MessageDto; created: boolean } {
    // The same clientId reused for a different conversation is a client bug, not a retry.
    if (!message.conversationId.equals(conversation._id)) {
      throw Errors.conflict('This message id was already used');
    }
    return { message: toMessageDto(message), created: false };
  }
}
