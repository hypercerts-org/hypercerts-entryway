<script lang="ts">
  type Props = {
    mode: "start" | "confirm" | "ended";
    email: string;
    did: string;
    csrf: string;
    returnTo?: string;
    notMade?: boolean;
    challengeId?: string;
    resent?: boolean;
    error?: string;
    message?: string;
    signIn?: boolean;
  };
  let {
    mode,
    email,
    did,
    csrf,
    returnTo = "",
    notMade = false,
    challengeId = "",
    resent = false,
    error,
    message,
    signIn = false,
  }: Props = $props();
</script>

<p>Account DID: <code>{did}</code></p>
{#if mode === "start"}
  {#if notMade}<p role="alert">
      Your change was not made. It has been more than ten minutes since you
      signed in or last confirmed it's you. Confirm it's you, then make the
      change again.
    </p>{/if}
  <p id="reconfirm-help">
    For your security, changes to account security settings need a recent
    confirmation. We'll send an eight-digit code to <strong>{email}</strong>.
  </p>
  <form method="post" action="/account/confirm/start">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><input type="hidden" name="returnTo" value={returnTo} /><button
      aria-describedby="reconfirm-help"
    >
      Send code
    </button>
  </form>
  <p>
    <a href={`/account?did=${encodeURIComponent(did)}`}>
      Cancel and return to account settings
    </a>
  </p>
{:else if mode === "confirm"}
  {#if error}<p role="alert">{error}</p>{/if}
  <p id="reconfirm-help" role="status">
    {#if resent}We sent a new code to <strong>{email}</strong>. The earlier code
      no longer works. This one expires in ten minutes.{:else}We sent a code to <strong>
        {email}
      </strong>. Enter it to continue; it expires in ten minutes.{/if}
  </p>
  <form method="post" action="/account/confirm">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><input type="hidden" name="challengeId" value={challengeId} /><label
      for="reconfirm-code"
    >
      Confirmation code
    </label><input
      id="reconfirm-code"
      name="token"
      inputmode="numeric"
      autocomplete="one-time-code"
      minlength="8"
      maxlength="8"
      aria-describedby="reconfirm-help"
      required
    /><button>Confirm and continue</button>
  </form>
  <form method="post" action="/account/confirm">
    <input type="hidden" name="csrf" value={csrf} /><input
      type="hidden"
      name="did"
      value={did}
    /><input type="hidden" name="challengeId" value={challengeId} /><input
      type="hidden"
      name="resend"
      value="1"
    /><button class="secondary">Send a new code</button>
  </form>
  <p>
    <a href={`/account?did=${encodeURIComponent(did)}`}>
      Cancel and return to account settings
    </a>
  </p>
{:else}
  <p role="alert">{message}</p>
  <p>
    <a href={`/account?did=${encodeURIComponent(did)}`}>
      Return to account settings
    </a>
  </p>
  {#if signIn}<p class="muted">
      You can also <a href="/login">sign in again</a>.
    </p>{/if}
{/if}
