/** Small capability bridge; credentials and decrypted content never cross it. */
type Bridge = { postMessage(message: Record<string, unknown>): Promise<unknown> };
function bridge(): Bridge | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: { porchday?: Bridge } } }).webkit?.messageHandlers?.porchday;
}
export function isNativeShell() { return !!bridge(); }
export async function nativeCall(command: string, input: Record<string, unknown> = {}) {
  const handler = bridge();
  if (!handler) throw new Error('Native app support is unavailable.');
  return handler.postMessage({ version: 1, command, ...input });
}
export function nativeBadge(count: number) {
  if (isNativeShell() && Number.isSafeInteger(count) && count >= 0)
    void nativeCall('badge', { count }).catch(() => {});
}
export function nativeForeground() {
  return (window as unknown as { porchdayNativeActive?: boolean }).porchdayNativeActive !== false;
}
