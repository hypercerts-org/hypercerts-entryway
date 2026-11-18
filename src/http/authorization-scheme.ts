/** The credential that follows an `Authorization` scheme, or `undefined` when
 * the header uses another scheme. HTTP authentication schemes are
 * case-insensitive (RFC 9110), and the stock PDS matches them that way, so
 * `bearer` and `Bearer` select the same credential. The credential itself is
 * returned byte for byte. */
export function schemeCredential(
  header: unknown,
  scheme: "Basic" | "Bearer" | "DPoP",
): string | undefined {
  if (typeof header !== "string") return undefined;
  const length = scheme.length + 1;
  return header.slice(0, length).toLowerCase() === `${scheme.toLowerCase()} `
    ? header.slice(length)
    : undefined;
}

/** A Basic header with its scheme in canonical case and its credential
 * untouched, for a constant-time comparison against the expected header. Any
 * other header is the empty string, which matches no expected value. */
export function canonicalBasic(header: unknown): string {
  const credential = schemeCredential(header, "Basic");
  return credential === undefined ? "" : `Basic ${credential}`;
}
