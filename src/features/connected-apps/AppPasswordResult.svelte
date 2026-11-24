<script lang="ts">
  let { name, password, did }: { name: string; password: string; did: string } =
    $props();
</script>

<p>Copy this password into {name} now. It will not be shown again.</p>
<code
  style="display: block; overflow-wrap: anywhere; padding: 1rem; border: 1px solid var(--hc-line-strong); border-radius: var(--hc-radius-control); background: var(--hc-surface-panel); color: var(--hc-text-ink); user-select: all;"
>
  <span data-testid="app-password">{password}</span>
</code>
<p>
  <a href={`/account?did=${encodeURIComponent(did)}&view=apps#app-passwords`}>
    Return to account settings
  </a>
</p>
