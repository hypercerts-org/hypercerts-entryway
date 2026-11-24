<script lang="ts">
  interface Account {
    handle: string;
    email: string;
    pdsUrl: string;
    did: string;
    createdAt: string | number | Date;
    status: string;
  }
  interface PendingEmail {
    email: string;
  }
  let {
    account,
    csrf,
    canSwitchAccount,
    security,
    pendingEmail,
    pendingEmailChallengeId,
  }: {
    account: Account;
    csrf: string;
    canSwitchAccount: boolean;
    security: boolean;
    pendingEmail?: string | PendingEmail | null;
    pendingEmailChallengeId?: string | null;
  } = $props();
  const created = $derived(new Date(account.createdAt));
  const createdLabel = $derived(
    Number.isFinite(created.getTime())
      ? `${created.toISOString().replace("T", " ").slice(0, 16)} UTC`
      : "Unknown",
  );
  const email = $derived(
    typeof pendingEmail === "string" ? pendingEmail : pendingEmail?.email,
  );
</script>

<section id="identity" aria-labelledby="identity-title">
  <h2 id="identity-title">Identity and email</h2>
  <div class="account-context" aria-label="Current account and data host">
    <strong data-testid="account-handle">{account.handle}</strong><span>
      Signed in as {account.email}
    </span><span>Repository hosted at {account.pdsUrl}</span><span>
      Account DID <code data-testid="account-did">{account.did}</code>
    </span>
  </div>
  <dl class="identity">
    <dt>Handle</dt>
    <dd>{account.handle}</dd>
    <dt>Account DID</dt>
    <dd><code>{account.did}</code></dd>
    <dt>Personal data server</dt>
    <dd>{account.pdsUrl}</dd>
    <dt>Primary email</dt>
    <dd data-testid="primary-email">{account.email} (verified)</dd>
    <dt>Created</dt>
    <dd>{createdLabel}</dd>
    <dt>Account status</dt>
    <dd>Status: {account.status}</dd>
  </dl>
  <p class="muted">
    These settings apply only to the selected DID. {#if canSwitchAccount}<a
        href="/account"
      >
        Switch linked account
      </a>{/if}
  </p>
  {#if security}
    <h3>Change primary email</h3>
    <p>
      Verify your current email, then your new email. Your browser sessions will
      stay signed in for any other linked accounts. Sign in with your new email
      to access this account after the change.
    </p>
    <form method="post" action="/account/email-request">
      <input type="hidden" name="csrf" value={csrf} /><input
        type="hidden"
        name="did"
        value={account.did}
      /><button type="submit">Start email change</button>
    </form>
    {#if email}
      <p>Awaiting verification of {email}.</p>
      <form method="post" action="/account/email-confirm">
        <input type="hidden" name="csrf" value={csrf} /><input
          type="hidden"
          name="did"
          value={account.did}
        /><input
          type="hidden"
          name="challengeId"
          value={pendingEmailChallengeId ?? ""}
        /><input type="hidden" name="email" value={email} /><label>
          New email verification code<input
            name="token"
            type="text"
            autocomplete="one-time-code"
            maxlength="256"
            required
          />
        </label><button type="submit">Confirm new email</button>
      </form>
    {/if}
  {/if}
</section>
