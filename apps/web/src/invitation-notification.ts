export function invitationHandle(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_]{3,24}$/.test(value) ? value : null;
}
export function notificationPath(row: {kind?: string; actor_handle?: unknown; post_id?: string; group_id?: string}): string {
  const handle = row.kind === "invitation_joined" ? invitationHandle(row.actor_handle) : null;
  if (handle) return "/app/connections?handle=" + encodeURIComponent(handle);
  return row.post_id ? `/app/post/${row.post_id}` : row.group_id ? `/app/groups/${row.group_id}` : "/app/connections";
}
