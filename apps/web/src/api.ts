import type { EncryptedEnvelope, ContentContext } from "@porchday/crypto";
export type { EncryptedEnvelope, ContentContext };
export type Json = Record<string, any>;
export type Device = {
  id: string;
  member_id: string;
  public_key: string;
  fingerprint: string;
  encrypted_private_key?: string;
  name?: string;
  revoked_at?: string | null;
};
export type Member = {
  id: string;
  handle: string;
  status?: string;
  envelope?: EncryptedEnvelope | null;
  profile?: { handle?: string; envelope?: EncryptedEnvelope | null };
  created_at?: string;
};
export type SocialObject = {
  id: string;
  author_id: string;
  author_device_id?: string;
  envelope: EncryptedEnvelope;
  created_at: string;
  expires_at: string | null;
  effective_expires_at?: string | null;
  parent_id?: string | null;
  post_id?: string;
  group_id?: string | null;
  audience?: string;
  media_ids?: string[];
  reactions?: SocialObject[];
  comment_count?: number;
  author_handle?: string;
};
export type Content = {
  text?: string;
  name?: string;
  description?: string;
  displayName?: string;
  bio?: string;
  interests?: string;
  status?: string;
  theme?: string;
  accent?: string;
  emoji?: string;
  media?: MediaPayload[];
  avatar?: MediaPayload;
  cover?: MediaPayload;
  background?: MediaPayload;
  [key: string]: unknown;
};
export type MediaPayload = {
  id: string;
  alt: string;
  mime: string;
  name: string;
  width: number;
  height: number;
};
export class ApiError extends Error {
  code: string;
  status: number;
  details: Json;
  constructor(status: number, data: Json) {
    super(
      (
        {
          RECENT_AUTH_REQUIRED:
            "For this security-sensitive action, sign out and sign in again, then return here. Your draft remains until you leave.",
          AUDIENCE_CHANGED:
            "Your sharing audience changed. Review the audience and submit again to encrypt for the current recipients.",
          CONNECTION_LIMIT:
            "One of you has reached the 300-person limit, including family. A connection cannot be accepted until both people have room.",
          MEDIA_QUOTA:
            "Your encrypted photo storage is full. Export or remove older photos before adding more.",
          GROUP_LIMIT:
            "You have reached the limit of 30 owned groups. Transfer or delete one before creating another.",
          OWNED_GROUPS:
            "Transfer or delete the groups you own before deleting your account.",
          TRANSFER_REQUIRED:
            "Transfer group ownership or delete the group before leaving.",
          RATE_LIMIT: "Please pause for a moment, then try again.",
          REQUEST_LIMIT:
            "You have reached the pending request limit. Cancel old requests or wait for replies.",
          KEY_SETUP_REQUIRED:
            "Someone in this audience has not set up encryption yet. Wait for their keys before sharing; no one will be silently left out.",
          REVISION_CHANGED:
            "This content was updated elsewhere. Reload the current version before making another edit.",
          ACCOUNT_UNAVAILABLE:
            "This account is temporarily unavailable. Recovery and appeals remain accessible.",
          NOT_FOUND:
            "This content is no longer available or is not shared with you.",
          PILOT_CLOSED:
            "Pilot registration is not open yet. Keep your invitation for when your pilot is ready.",
        } as Record<string, string>
      )[data.error?.code || data.code] ||
        data.error?.message ||
        data.message ||
        "Something went wrong. Please try again.",
    );
    this.status = status;
    this.code = data.error?.code || data.code || "REQUEST_FAILED";
    this.details = data.error?.details || data.details || {};
  }
}
export async function request<T = Json>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    path.startsWith("/api/") ? path : `/api/v1${path}`,
    {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof Blob)
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
    },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data as T;
}
export const get = <T = Json>(path: string) => request<T>(path);
export const post = <T = Json>(path: string, data: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(data) });
export const patch = <T = Json>(path: string, data: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const del = <T = Json>(path: string) =>
  request<T>(path, { method: "DELETE" });
export const auth = <T = Json>(path: string, data: unknown) =>
  post<T>(`/api/auth/${path}`, data);
export function items<T>(value: any): T[] {
  return Array.isArray(value)
    ? value
    : value?.items ||
        value?.devices ||
        value?.connections ||
        value?.groups ||
        [];
}
export function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
export function displayTimeZone() {
  try {
    const zone = localStorage.getItem("porchday-timezone");
    if (zone) {
      new Intl.DateTimeFormat(undefined, { timeZone: zone }).format();
      return zone;
    }
  } catch {}
  return undefined;
}
export function localDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: displayTimeZone(),
  }).format(new Date(value));
}
export function relativeDate(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: displayTimeZone(),
  }).format(new Date(value));
}
export function remaining(value: string) {
  const seconds = Math.max(
    0,
    Math.ceil((new Date(value).getTime() - Date.now()) / 1000),
  );
  if (seconds < 60) return `${seconds} seconds remaining`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} minutes remaining`;
  if (seconds < 86400) return `${Math.ceil(seconds / 3600)} hours remaining`;
  return `${Math.ceil(seconds / 86400)} days remaining`;
}
export function deadline(duration: string, parent: string | null = null) {
  let chosen = duration.startsWith("custom:")
    ? new Date(duration.slice(7)).toISOString()
    : duration && duration !== "inherit" && duration !== "custom"
      ? new Date(Date.now() + Number(duration) * 1000).toISOString()
      : null;
  if (parent && (!chosen || new Date(parent) < new Date(chosen)))
    chosen = parent;
  return chosen;
}
export function unexpired(value: SocialObject) {
  return (
    !(value.effective_expires_at || value.expires_at) ||
    new Date(value.effective_expires_at || value.expires_at!).getTime() >
      Date.now()
  );
}
export function saveFile(data: Blob, name: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
