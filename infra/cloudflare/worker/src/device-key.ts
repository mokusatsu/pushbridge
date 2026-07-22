export function validDevicePublicKey(value: string): boolean {
  return /^p256\.[A-Za-z0-9_-]{87}$/.test(value);
}
