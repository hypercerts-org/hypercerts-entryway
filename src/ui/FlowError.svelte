<script lang="ts">
  import { Button, ErrorMessage } from "@hypercerts-org/ui-svelte";
  interface Props {
    message: string;
    restart?: { flow: string; csrf: string };
  }
  let { message, restart }: Props = $props();
</script>

<ErrorMessage>{message}</ErrorMessage>
{#if restart}
  <form method="post" action="/auth/restart">
    <input type="hidden" name="flow" value={restart.flow} />
    <input type="hidden" name="csrf" value={restart.csrf} />
    <Button type="submit" class="primary-action">Restart sign-in</Button>
  </form>
{:else}
  <Button href="/login" class="primary-action">Start a new sign-in</Button>
{/if}
