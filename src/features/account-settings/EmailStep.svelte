<script lang="ts">
  type Props = {
    kind: "backup" | "current" | "new";
    csrf: string;
    did: string;
    email: string;
    challengeId: string;
  };
  let { kind, csrf, did, email, challengeId }: Props = $props();
  let action = $derived(
    kind === "backup"
      ? "backup-confirm"
      : kind === "current"
        ? "email-update"
        : "email-confirm",
  );
  let message = $derived(
    kind === "backup"
      ? "Enter the verification code sent to your recovery email."
      : kind === "current"
        ? "A verification code was sent to your current primary email."
        : "Verify the code sent to your new primary email to complete the change.",
  );
  let label = $derived(
    kind === "backup"
      ? "Recovery email verification code"
      : kind === "current"
        ? "Current email verification code"
        : "New email verification code",
  );
  let button = $derived(
    kind === "backup"
      ? "Verify recovery email"
      : kind === "current"
        ? "Verify current email and continue"
        : "Confirm new email",
  );
</script>

<p>Account DID: <code>{did}</code></p>
<p role="status">{message}</p>
<form method="post" action={`/account/${action}`}>
  <input type="hidden" name="csrf" value={csrf} /><input
    type="hidden"
    name="did"
    value={did}
  /><input type="hidden" name="challengeId" value={challengeId} />
  {#if kind !== "current"}<input
      type="hidden"
      name="email"
      value={email}
    />{/if}
  <label>
    {label}<input
      name="token"
      type="text"
      autocomplete="one-time-code"
      maxlength="256"
      required
    />
  </label>
  {#if kind === "current"}<label>
      New primary email<input
        name="email"
        type="email"
        maxlength="320"
        required
      />
    </label>{/if}
  <button type="submit">{button}</button>
</form>
<a
  href={`/account?did=${encodeURIComponent(did)}&view=account#${kind === "backup" ? "recovery" : "identity"}`}
>
  Return to account settings
</a>
