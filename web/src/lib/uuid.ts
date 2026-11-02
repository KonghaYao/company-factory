/**
 * UUID v4 for browser code. `crypto.randomUUID` is secure-context only, so it
 * is undefined when the workbench is opened over plain HTTP on a LAN address.
 * `crypto.getRandomValues` (and even Math.random as a last resort) still work.
 *
 * This is a client-side correlation/idempotency value, not a resource ID:
 * Company/Agent/Issue IDs remain backend-generated.
 */
const fallbackUuid = (): string => {
  const bytes = new Uint8Array(16);
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.getRandomValues === "function"
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const uuid = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return fallbackUuid();
};

/**
 * Install the fallback for code we do not own (Monaco, Peri chat shell, OpenUI).
 * Those bundles call `crypto.randomUUID()` without a guard.
 */
export const installUuidPolyfill = (): void => {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID === "function")
    return;
  Object.defineProperty(crypto, "randomUUID", {
    value: fallbackUuid,
    configurable: true,
    writable: true,
  });
};
