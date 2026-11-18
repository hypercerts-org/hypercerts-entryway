/** The credential that follows an `Authorization` scheme, or `undefined` when
 * the header uses another scheme. HTTP authentication schemes are
 * case-insensitive (RFC 9110), and the stock PDS matches them that way, so
 * `bearer` and `Bearer` select the same credential. */
export function schemeCredential(
  header: unknown,
  scheme: "Bearer" | "DPoP",
): string | undefined {
  if (typeof header !== "string") return undefined;
  const length = scheme.length + 1;
  return header.slice(0, length).toLowerCase() === `${scheme.toLowerCase()} `
    ? header.slice(length)
    : undefined;
}
