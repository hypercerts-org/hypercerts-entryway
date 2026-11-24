<script lang="ts">
  import { Avatar } from "@hypercerts-org/ui-svelte";

  interface Account {
    did: string;
    handle?: string | null;
    status?: string | null;
  }
  interface Props {
    accounts: Account[];
    action: string;
    fields: { name: string; value: string }[];
    prompt: string;
    anotherEmailAction?: string;
  }
  let { accounts, action, fields, prompt, anotherEmailAction }: Props =
    $props();
</script>

<p role="status">{prompt}</p>
{#each accounts as account (account.did)}
  <form method="post" {action}>
    {#each fields as field (field.name)}
      <input type="hidden" name={field.name} value={field.value} />
    {/each}
    <input type="hidden" name="did" value={account.did} />
    <button
      class="account-choice"
      aria-label={`Continue with this account: ${account.handle ?? account.did}, ${account.did}`}
    >
      <Avatar name={account.handle ?? account.did} size="sm" />
      <span class="account-choice-details">
        <strong>{account.handle ?? account.did}</strong><small>
          {account.did}{account.status ? ` · ${account.status}` : ""}
        </small>
      </span>
      <span aria-hidden="true">›</span>
    </button>
  </form>
{/each}

{#if anotherEmailAction}
  <form method="post" action={anotherEmailAction}>
    {#each fields as field (field.name)}
      <input type="hidden" name={field.name} value={field.value} />
    {/each}
    <button class="account-choice another-email-choice">
      <span>Use another email address</span><span aria-hidden="true">›</span>
    </button>
  </form>
{/if}
