<script lang="ts">
  type Props = {
    message: string;
    accountUrl: string;
    recovery?: boolean;
    pending?: { handle: string; did: string; target: string };
  };
  let { message, accountUrl, recovery = false, pending }: Props = $props();
</script>

<p role="alert">{message}</p>
{#if pending}
  <p>
    The saved account is <strong>{pending.handle}</strong> (<code>
      {pending.did}
    </code>) on {pending.target}. Keep this account and the original requested
    change when continuing after verified recovery.
  </p>
  <p><a href={accountUrl}>Return to account settings</a></p>
{:else}
  {#if recovery}<p>
      Your saved change is still pending. Contact the service operator. Retrying
      or signing in again alone cannot settle an uncertain server request;
      continue the saved change after recovery is authorized.
    </p>{/if}
  <p>
    <a href={accountUrl}>Return to account settings</a> ·
    <a href="/login">Sign in again</a>
  </p>
{/if}
