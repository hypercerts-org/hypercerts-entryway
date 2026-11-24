<script lang="ts">
  import { Button, Input } from "@hypercerts-org/ui-svelte";

  interface Props {
    flow: string;
    csrf: string;
    email?: string;
  }
  let { flow, csrf, email = "" }: Props = $props();
</script>

<form method="post" action="/auth/email">
  <input type="hidden" name="flow" value={flow} />
  <input type="hidden" name="csrf" value={csrf} />
  <label for="email">Email address</label>
  <Input
    id="email"
    name="email"
    type="email"
    autocomplete="email"
    value={email}
    required
  />
  <Button class="primary-action" type="submit">Send sign-in code</Button>
</form>
