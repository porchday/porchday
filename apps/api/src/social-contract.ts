import { z } from 'zod';
import type { EncryptedEnvelope } from '@porchday/crypto';
export interface SocialPost {
    id: string;
    author_id: string;
    group_id: string | null;
    audience: 'connections' | 'family' | 'only_me' | 'group';
    envelope: EncryptedEnvelope;
    epoch: number;
    created_at: string;
    edited_at: string | null;
    expires_at: string | null;
    media?: {
        id: string;
        byte_size: number;
        envelope: EncryptedEnvelope;
    }[];
}
export interface SocialComment {
    id: string;
    author_id: string;
    post_id: string;
    parent_id: string | null;
    envelope: EncryptedEnvelope;
    created_at: string;
    expires_at: string | null;
    effective_expires_at: string | null;
}
export interface SocialReaction {
    post_id?: string;
    comment_id?: string;
    member_id: string;
    reaction_tag: string;
    envelope: EncryptedEnvelope;
}
export interface AudienceSnapshot {
    epoch: number;
    devices: {
        id: string;
        member_id: string;
        public_key: string;
        fingerprint: string;
    }[];
}
export interface Page<T> {
    items: T[];
    next_cursor: string | null;
}
export interface ApiError {
    error: {
        code: string;
        message: string;
        details?: unknown;
    };
}
const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const contextSchema = z.object({ id: z.string().min(1).max(128), kind: z.enum(['post', 'comment', 'reaction', 'profile', 'group', 'media', 'report', 'export']), authorId: uuid, authorDeviceId: uuid, audience: z.enum(['only_me', 'connections', 'family', 'group', 'moderators']), parentId: uuid.nullable(), groupId: uuid.nullable(), epoch: z.number().int().nonnegative(), createdAt: date, expiresAt: date.nullable(), revision: z.number().int().positive() }).strict();
export const envelopeSchema = z.object({ v: z.literal(1), protocol: z.literal('porchday-openpgp-v1'), context: contextSchema, recipients: z.array(z.object({ memberId: uuid, deviceId: uuid, fingerprint: z.string().regex(/^[0-9a-f]{40,64}$/) }).strict()).min(1).max(4000), ciphertext: z.string().startsWith('-----BEGIN PGP MESSAGE-----').max(22000000) }).strict();
