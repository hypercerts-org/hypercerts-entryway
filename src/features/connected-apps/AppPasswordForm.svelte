<script lang="ts">
  import { Button, Checkbox, Input } from "@hypercerts-org/ui-svelte";
  let { csrf, did }: { csrf: string; did: string } = $props();
</script>

<p>
  Give each legacy application its own password. The generated password is shown
  once.
</p>
<form method="post" action="/account/app-password-create">
  <input type="hidden" name="csrf" value={csrf} />
  <input type="hidden" name="did" value={did} />
  <label>
    App password name<Input name="name" type="text" maxlength="64" required />
  </label>
  <Checkbox
    label="Allow direct-message access"
    name="privileged"
    value="true"
    style="min-height: 0; padding: 0;"
  />
  <Button type="submit">Create app password</Button>
</form>
