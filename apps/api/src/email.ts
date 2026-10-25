import type { Env } from './types';
import { event } from './telemetry';
export async function sendAccountEmail(env: Env, to: string, subject: string, text: string) {
  // Email contains only the intended account message, never social content or key material.
  if (!env.EMAIL) throw new Error('EMAIL_UNAVAILABLE');
  try {
    await env.EMAIL.send({ from: env.EMAIL_FROM, to, subject, text });
    event('email', { code:'accepted' },env);
  } catch {
    event('email', { code:'send_failed' },env);
    throw new Error('EMAIL_UNAVAILABLE');
  }
}
