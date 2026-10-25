// Recovery completion has different remedies from contact confirmation or reset.
// Never display provider text: it can contain private details, and an uncertain
// response does not prove that the credential change was rolled back.
const recoveryMessages: Readonly<Record<string, string>> = {
  INVALID_OR_USED_LINK:
    "This restoration link is no longer valid. It may have expired, already been used, or been replaced. Open the newest restoration email. If you already restored access, sign in with your new password; otherwise, resume your recovery case to request a fresh reviewed link.",
  INVALID_RECOVERY:
    "This restoration request could not be validated. Use the newest restoration email and a password between 12 and 128 characters. If this continues, resume your recovery case for help.",
  REVIEW_REQUIRED:
    "The recovery review needs to be confirmed again before access can be restored. Resume your recovery case and ask the reviewers to check it.",
  CONTACT_UNAVAILABLE:
    "Access could not be restored using the verified safe contact address. Resume your recovery case so the reviewers can help resolve the contact details.",
  RATE_LIMITED:
    "There have been too many restoration attempts. Wait at least 15 minutes before trying again. Your password draft remains in this tab.",
  PASSWORD_COMPROMISED:
    "Choose a different password that has not appeared in known breaches. Never reuse a password from another account.",
};

export const recoveryUnconfirmedMessage =
  "We could not confirm whether your login access was restored. Your password draft remains in this tab. If you may have completed restoration, try signing in with your new password; otherwise, resume your recovery case for help before submitting again.";

export async function completeRecovery(
  token: string,
  newPassword: string,
): Promise<void> {
  let response: Response;
  let data: unknown;
  try {
    response = await fetch("/api/account-recovery/complete", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });
    data = await response.json();
  } catch {
    throw new Error(recoveryUnconfirmedMessage);
  }
  const result = data as {
    ok?: unknown;
    signInRequired?: unknown;
    encryptionRecoveryRequired?: unknown;
    error?: { code?: unknown };
  } | null;
  if (
    response.status === 200 &&
    result?.ok === true &&
    result.signInRequired === true &&
    result.encryptionRecoveryRequired === true
  ) return;

  const code = result?.error?.code;
  throw new Error(
    response.status !== 200 && typeof code === "string" && Object.hasOwn(recoveryMessages, code)
      ? recoveryMessages[code]
      : recoveryUnconfirmedMessage,
  );
}
