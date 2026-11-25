/** Exact protected-resource identifier required for the nominated host profile. */
export function registryProtectedResource(
  publicUrl: string,
  staged: boolean,
): string {
  return staged ? publicUrl : new URL(publicUrl).origin;
}
