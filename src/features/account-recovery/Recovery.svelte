<script lang="ts">
  let {
    step,
    csrf,
    challengeId = "",
  }: {
    step: "request" | "verify" | "complete" | "done";
    csrf: string;
    challengeId?: string;
  } = $props();
</script>

{#if step === "request"}
  <p>
    Use a recovery email you verified before losing access to your primary
    mailbox.
  </p>
  <form method="post" action="/recover/request">
    <input type="hidden" name="csrf" value={csrf} /><label>
      Verified recovery email<input
        name="email"
        type="email"
        autocomplete="email"
        maxlength="320"
        required
      />
    </label><button type="submit">Send recovery code</button>
  </form>
  <a href="/login">Return to sign in</a>
{:else if step === "verify"}
  <p>
    If this is a verified recovery email, a code has been sent. Enter it and
    choose a new primary email.
  </p>
  <form method="post" action="/recover/verify">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="challengeId"
      value={challengeId}
    /><label>
      Recovery code<input
        name="token"
        type="text"
        autocomplete="one-time-code"
        maxlength="256"
        required
      />
    </label><label>
      New primary email<input
        name="newEmail"
        type="email"
        maxlength="320"
        required
      />
    </label><button type="submit">Verify recovery code</button>
  </form>
  <a href="/recover">Start again</a>
{:else if step === "complete"}
  <p>
    Enter the verification code sent to the new primary email. Existing sessions
    will end after recovery.
  </p>
  <form method="post" action="/recover/complete">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="challengeId"
      value={challengeId}
    /><label>
      New primary email verification code<input
        name="token"
        type="text"
        autocomplete="one-time-code"
        maxlength="256"
        required
      />
    </label><button type="submit">Complete account recovery</button>
  </form>
{:else}
  <p>Your primary email was updated and existing sessions were ended.</p>
  <a href="/login">Sign in with your recovered account</a>
{/if}
