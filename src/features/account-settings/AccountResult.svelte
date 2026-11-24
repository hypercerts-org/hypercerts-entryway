<script lang="ts">
  let {
    kind,
    did,
  }: { kind: "email" | "password-set" | "password-remove"; did: string } =
    $props();
</script>

{#if kind === "email"}
  <p>
    Your email was changed. Your browser sessions remain signed in for any other
    linked accounts, but no longer have access to this account.
  </p>
  <a href="/login">Sign in with your new email</a>
{:else}
  <p>
    {kind === "password-set"
      ? "Your password was updated. Existing sessions and app passwords were revoked."
      : "Email sign-in remains available. Existing sessions and app passwords were revoked."}
  </p>
  <a href="/login">Sign in again</a>
  <p>
    <a href={`/account?did=${encodeURIComponent(did)}`}>
      Return to account settings
    </a>
  </p>
{/if}
