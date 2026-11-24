<script lang="ts">
  let {
    security,
    legacy,
    passwordEnabled,
    did,
  }: {
    security: boolean;
    legacy: boolean;
    passwordEnabled: boolean;
    did: string;
  } = $props();
</script>

<h2 id="passwords-title">Passwords</h2>
{#if security && legacy}
  <p>
    {passwordEnabled
      ? "Optional account password is enabled."
      : "This account has no account password. Email sign-in remains available."}
    Passwords here support apps that use the legacy AT Protocol sign-in API. Changing
    or removing a password ends all sessions and removes existing app passwords.
  </p>
  <p>
    <a
      class="button"
      href={`/account/manage/password?did=${encodeURIComponent(did)}`}
    >
      {passwordEnabled ? "Change account password" : "Set account password"}
    </a>
  </p>
{:else}<p>Password management is not available yet.</p>{/if}
