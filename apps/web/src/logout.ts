import { forgetAllDevices } from "@porchday/crypto/browser";
import { auth } from "./api";
import { unsubscribeCurrentPush } from "./push";

export async function signOutSafely() {
  await unsubscribeCurrentPush();
  await forgetAllDevices();
  try {
    await auth("sign-out", {});
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 401
    )
      return;
    throw new Error(
      "This browser’s encryption keys were cleared, but the server could not confirm sign-out. Reconnect and sign out again; the login session may still be active.",
    );
  }
}
