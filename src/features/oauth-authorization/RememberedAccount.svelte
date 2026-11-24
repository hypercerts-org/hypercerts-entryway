<script lang="ts">
  import { Avatar, Button } from "@hypercerts-org/ui-svelte";
  interface Props {
    flow: string;
    csrf: string;
    did: string;
    handle: string;
  }
  let { flow, csrf, did, handle }: Props = $props();
</script>

<div class="remembered-account">
  <Avatar name={handle} size="sm" />
  <div><strong>{handle}</strong><small>{did}</small></div>
  <form method="post" action="/auth/remembered-login">
    <input type="hidden" name="flow" value={flow} />
    <input type="hidden" name="csrf" value={csrf} />
    <input type="hidden" name="did" value={did} />
    <Button type="submit" variant="secondary">
      Sign in with an email code
    </Button>
  </form>
</div>
