/** Without a list every origin passes, with one only those on it. */
export function isAllowedOrigin(origin: string | undefined, allowed?: readonly string[]): boolean {
  if (allowed === undefined) {
    return true;
  }
  return origin !== undefined && allowed.includes(origin);
}
