<script lang="ts">
  let { name, password, did }: { name: string; password: string; did: string } =
    $props();
</script>

<p>Copy this password into {name} now. It will not be shown again.</p>
<code data-testid="app-password">{password}</code>
<p>
  <a href={`/account?did=${encodeURIComponent(did)}#passwords`}>
    Return to account settings
  </a>
</p>
