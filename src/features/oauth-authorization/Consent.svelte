<script lang="ts">
  import { Avatar, Button } from "@hypercerts-org/ui-svelte";

  interface Props {
    flow: string;
    csrf: string;
    did: string;
    handle: string;
    clientName: string;
    scopes: {
      label: string;
      values: { value: string; description: string }[];
    }[];
    canChoose: boolean;
  }
  let { flow, csrf, did, handle, clientName, scopes, canChoose }: Props =
    $props();
</script>

<div class="consent-identity">
  <Avatar name={handle} size="sm" />
  <div><strong>{handle}</strong><small>{did}</small></div>
</div>
{#if canChoose}
  <form method="post" action="/auth/choose">
    <input type="hidden" name="flow" value={flow} />
    <input type="hidden" name="csrf" value={csrf} />
    <Button variant="ghost" class="secondary-action" type="submit">
      Choose a different account
    </Button>
  </form>
  <form method="post" action="/auth/another-account">
    <input type="hidden" name="flow" value={flow} />
    <input type="hidden" name="csrf" value={csrf} />
    <Button variant="ghost" class="secondary-action" type="submit">
      Use another email address
    </Button>
  </form>
{/if}
<p><strong>{clientName}</strong> requests access:</p>
<ul class="scope-list">
  {#each scopes as scope (scope)}
    <li>
      <strong>{scope.label}</strong>{#each scope.values as item (item.value)}
        <span>{item.description}</span><code>{item.value}</code>
      {/each}
    </li>
  {/each}
</ul>
<form method="post" action="/auth/consent" class="consent-actions">
  <input type="hidden" name="flow" value={flow} />
  <input type="hidden" name="csrf" value={csrf} />
  <input type="hidden" name="did" value={did} />
  <Button class="primary-action" type="submit" name="decision" value="approve">
    Allow access
  </Button>
  <Button
    variant="secondary"
    class="secondary-action"
    type="submit"
    name="decision"
    value="deny"
  >
    Cancel
  </Button>
</form>
