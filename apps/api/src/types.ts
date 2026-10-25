export interface Env {
  HYPERDRIVE_AUTH: Hyperdrive;
  HYPERDRIVE_SOCIAL: Hyperdrive;
  HYPERDRIVE_JOBS: Hyperdrive;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  EMAIL: SendEmail;
  JOBS: Queue<{ kind: string; id?: string }>;
  APP_URL: string;
  ENVIRONMENT: 'development' | 'staging' | 'production';
  BETTER_AUTH_SECRET: string;
  EMAIL_FROM: string;
  SIGNUP_ENABLED?: string;
  STAFF_ACCESS_ISSUER?: string;
  STAFF_ACCESS_AUDIENCE?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
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
