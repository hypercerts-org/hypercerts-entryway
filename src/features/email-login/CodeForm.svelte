<script lang="ts">
  import { Button, ErrorMessage, Input } from "@hypercerts-org/ui-svelte";

  interface Props {
    flow: string;
    csrf: string;
    shownEmail: string;
    changeEmail: string;
    error?: string;
    oauth: boolean;
  }
  let {
    flow,
    csrf,
    shownEmail,
    changeEmail,
    error = "",
    oauth,
  }: Props = $props();
</script>

{#if error}
  <ErrorMessage id="otp-error" aria-live="polite">{error}</ErrorMessage>
{/if}
<p id="otp-help" role="status" aria-live="polite">
  Enter the code sent to <strong>{shownEmail}</strong>. Codes expire after ten
  minutes.
</p>
<form method="post" action="/auth/verify" class="code-form">
  <input type="hidden" name="flow" value={flow} />
  <input type="hidden" name="csrf" value={csrf} />
  <label for="otp">Sign-in code</label>
  {#if oauth}
    <div class="otp-cells">
      {#each Array.from({ length: 8 }, (_, index) => index) as index (index)}<span
          class="otp-cell"
          aria-hidden="true"
        ></span>{/each}
      <input
        id="otp"
        name="otp"
        class="oauth-code"
        inputmode="numeric"
        autocomplete="one-time-code"
        minlength="8"
        maxlength="8"
        aria-describedby={`${error ? "otp-error " : ""}otp-help`}
        required
      />
    </div>
  {:else}
    <Input
      id="otp"
      name="otp"
      inputmode="numeric"
      autocomplete="one-time-code"
      minlength="8"
      maxlength="8"
      aria-describedby={`${error ? "otp-error " : ""}otp-help`}
      required
    />
  {/if}
  <Button class="primary-action" type="submit">Verify code</Button>
</form>
<div class="code-actions">
  <form method="post" action="/auth/resend">
    <input type="hidden" name="flow" value={flow} />
    <input type="hidden" name="csrf" value={csrf} />
    <Button variant="ghost" class="secondary-action" type="submit">
      Send a new code
    </Button>
  </form>
  <p class="muted">
    Wait five seconds between code requests. Each email address has a ten-minute
    request limit.
  </p>
  <form method="post" action="/auth/email">
    <input type="hidden" name="flow" value={flow} />
    <input type="hidden" name="csrf" value={csrf} />
    <label for="change-email">Use a different email address</label>
    <Input
      id="change-email"
      name="email"
      type="email"
      autocomplete="email"
      value={changeEmail}
      required
    />
    <Button variant="ghost" class="secondary-action" type="submit">
      Change email and send a new code
    </Button>
  </form>
</div>
