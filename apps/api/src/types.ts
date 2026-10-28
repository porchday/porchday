import type {PreparedMemberAuth} from './session';
import type {RequestTiming} from './request-timing';
export interface Env {
  METRICS?: AnalyticsEngineDataset;
  /** Temporary aggregate diagnostics; honored only in staging, never production. */
  FEED_PHASE_TIMING?: string;
  /** Opt-in aggregate logout diagnostics; no identities or request correlation. */
  LOGOUT_PHASE_TIMING?: string;
  HYPERDRIVE_AUTH: Hyperdrive;
  HYPERDRIVE_SOCIAL: Hyperdrive;
  HYPERDRIVE_JOBS: Hyperdrive;
  MEDIA: R2Bucket;
  MEDIA_BACKUP?: R2Bucket;
  MEDIA_BACKUP_ENABLED?: string;
  RECOVERY_JOURNAL?: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  JOBS: Queue<{ kind: string; id?: string }>;
  APP_URL: string;
  /** Explicit old HTTPS origin retained during a canonical-domain transition. */
  LEGACY_APP_URL?: string;
  ENVIRONMENT: 'development' | 'staging' | 'production';
  BETTER_AUTH_SECRET: string;
  EMAIL_FROM: string;
  SIGNUP_ENABLED?: string;
  CONTENT_WRITES_PAUSED?: string;
  MEDIA_UPLOADS_PAUSED?: string;
  SOCIAL_INVITATIONS_PAUSED?: string;
  /** Builder chat stays paused unless this is exactly 'false'. */
  BUILDER_CHAT_PAUSED?: string;
  BUILDER_BRIDGE_TOKEN?: string;
  OPERATIONS_HEALTH_TOKEN?: string;
  STAFF_ACCESS_ISSUER?: string;
  STAFF_ACCESS_AUDIENCE?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_PRIVATE_KEY?: string;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}
export interface Variables {
  requestTiming?: RequestTiming;
  preparedMemberAuth?: PreparedMemberAuth;
  memberId: string;
  authTime: number;
  sessionId: string;
  requestId: string;
  staffSubject: string;
  staffEmail: string;
  staffRoles: ('recovery' | 'moderation' | 'builder_chat')[];
}
