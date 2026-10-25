export interface Env {
  METRICS?: AnalyticsEngineDataset;
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
  ENVIRONMENT: 'development' | 'staging' | 'production';
  BETTER_AUTH_SECRET: string;
  EMAIL_FROM: string;
  SIGNUP_ENABLED?: string;
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
  memberId: string;
  authTime: number;
  sessionId: string;
  requestId: string;
  staffSubject: string;
  staffRoles: ('recovery' | 'moderation')[];
}
