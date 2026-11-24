<script lang="ts">
  let { name, password, did }: { name: string; password: string; did: string } =
    $props();
</script>

<p>Copy this password into {name} now. It will not be shown again.</p>
<code
  data-testid="app-password"
  style="display: block; overflow-wrap: anywhere; padding: 1rem; border: 1px solid var(--hc-line-strong); border-radius: var(--hc-radius-control); background: var(--hc-surface-panel); color: var(--hc-text-ink); user-select: all;"
>
  {password}
</code>
<p>
  <a href={`/account?did=${encodeURIComponent(did)}#passwords`}>
    Return to account settings
  </a>
</p>
