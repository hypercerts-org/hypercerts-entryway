<script lang="ts">
  import type { Snippet, Component } from "svelte";
  import {
    Mail,
    AtSign,
    KeyRound,
    ShieldCheck,
    Database,
    CirclePower,
    ChevronRight,
  } from "@lucide/svelte";
  let {
    email,
    handle,
    passwordEnabled,
    status,
    identity,
    handleForm,
    recovery,
    password,
    lifecycle,
    migration,
  }: {
    email: string;
    handle: string;
    passwordEnabled: boolean;
    status: string;
    identity: Snippet;
    handleForm: Snippet;
    recovery: Snippet;
    password: Snippet;
    lifecycle: Snippet;
    migration?: Snippet;
  } = $props();
  const rows = $derived([
    {
      key: "email",
      label: "Email and identity",
      value: email,
      icon: Mail,
      content: identity,
    },
    {
      key: "handle",
      label: "Handle",
      value: handle,
      icon: AtSign,
      content: handleForm,
    },
    {
      key: "recovery",
      label: "Recovery email",
      value: "Manage recovery addresses",
      icon: ShieldCheck,
      content: recovery,
    },
    {
      key: "password",
      label: "Account password",
      value: passwordEnabled ? "Enabled" : "Not set",
      icon: KeyRound,
      content: password,
    },
    {
      key: "lifecycle",
      label: "Account status and deletion",
      value: status,
      icon: CirclePower,
      content: lifecycle,
    },
    ...(migration
      ? [
          {
            key: "migration",
            label: "Data server",
            value: "Manage your data server",
            icon: Database,
            content: migration,
          },
        ]
      : []),
  ] satisfies {
    key: string;
    label: string;
    value: string;
    icon: Component;
    content: Snippet;
  }[]);
</script>

<div class="account-operation-rows">
  {#each rows as row (row.key)}
    <details>
      <summary>
        <span class="destination-icon">
          <row.icon aria-hidden="true" size={24} />
        </span>
        <span><strong>{row.label}</strong><small>{row.value}</small></span>
        <ChevronRight class="row-chevron" aria-hidden="true" size={20} />
      </summary>
      <div
        class="account-operation-content"
        id={row.key === "handle" ? "handle" : undefined}
      >
        {@render row.content()}
      </div>
    </details>
  {/each}
</div>
