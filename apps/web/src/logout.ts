import {isNativeShell,nativeCall} from "./native-shell";
import { forgetAllDevices } from "@porchday/crypto/browser";
import { auth } from "./api";
import { unsubscribeCurrentPush } from "./push";

export async function signOutSafely() {
  await unsubscribeCurrentPush();
  await forgetAllDevices();
  let nativeError: unknown;
  if (isNativeShell()) { try { await nativeCall("logout"); } catch (error) { nativeError = error; } }
  try {
    await auth("sign-out", {});
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 401
    )
      { if (nativeError) throw nativeError; return; }
    throw new Error(
      "This browser’s encryption keys were cleared, but the server could not confirm sign-out. Reconnect and sign out again; the login session may still be active.",
    );
  }
  if (nativeError) throw nativeError;
}
