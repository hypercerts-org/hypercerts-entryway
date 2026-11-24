<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    House,
    User,
    MonitorSmartphone,
    Globe,
    CircleQuestionMark,
    ChevronRight,
    ArrowLeft,
    Menu,
  } from "@lucide/svelte";
  type View = "home" | "account" | "devices" | "apps" | "about";
  let {
    did,
    handle,
    email,
    pdsUrl,
    view,
    canSwitchAccount,
    csrf,
    content,
  }: {
    did: string;
    handle: string;
    email: string;
    pdsUrl: string;
    view: View;
    canSwitchAccount: boolean;
    csrf: string;
    content: Snippet;
  } = $props();
  const base = $derived(`/account?did=${encodeURIComponent(did)}`);
  const links: {
    view: View;
    label: string;
    description: string;
    icon: typeof House;
  }[] = [
    {
      view: "home",
      label: "Home",
      description: "Account overview",
      icon: House,
    },
    {
      view: "account",
      label: "Account",
      description: "Identity, sign-in, recovery and data server",
      icon: User,
    },
    {
      view: "devices",
      label: "Devices",
      description: "Manage browsers and remembered devices",
      icon: MonitorSmartphone,
    },
    {
      view: "apps",
      label: "Apps",
      description: "Manage app permissions and sessions",
      icon: Globe,
    },
    {
      view: "about",
      label: "About",
      description: "Learn about your account and data",
      icon: CircleQuestionMark,
    },
  ];
  const url = (target: View) =>
    target === "home" ? base : `${base}&view=${target}`;
</script>

{#snippet navigation()}
  <nav aria-label="Account navigation">
    {#each links as link (link.view)}
      <a
        href={url(link.view)}
        aria-current={view === link.view ? "page" : undefined}
      >
        <link.icon aria-hidden="true" size={20} />
        {link.label}
      </a>
    {/each}
  </nav>
{/snippet}
<div class="account-shell">
  <aside class="account-sidebar">
    <strong class="account-brand">Entryway</strong>
    {@render navigation()}
    <div class="sidebar-footer">
      <p class="sidebar-account">
        <strong>{handle}</strong><br /><small>{email}</small><br /><small>
          <code>{did}</code>
        </small>
      </p>
      {#if canSwitchAccount}<a href="/account">Switch linked account</a>{/if}
      <form method="post" action="/auth/logout">
        <input type="hidden" name="csrf" value={csrf} /><input
          type="hidden"
          name="did"
          value={did}
        /><button type="submit">Sign out</button>
      </form>
    </div>
  </aside>
  <div class="account-main">
    <header class="account-mobile-header">
      {#if view !== "home"}<a href={base}>
          <ArrowLeft aria-hidden="true" size={18} /> Home
        </a>{/if}
      <details>
        <summary>
          <Menu aria-hidden="true" size={18} /> Menu
        </summary>{@render navigation()}{#if canSwitchAccount}<a
            href="/account"
          >
            Switch linked account
          </a>{/if}
        <form method="post" action="/auth/logout">
          <input type="hidden" name="csrf" value={csrf} /><input
            type="hidden"
            name="did"
            value={did}
          /><button type="submit">Sign out</button>
        </form>
      </details>
      <h1>{links.find((link) => link.view === view)?.label}</h1>
      <strong>Entryway</strong>
    </header>
    {#if view !== "home"}<p class="mobile-identity">
        {handle} · <code>{did}</code>
      </p>{/if}
    {#if view === "home"}
      <div class="account-summary">
        <div class="account-avatar" aria-hidden="true">
          {handle.slice(0, 1).toUpperCase()}
        </div>
        <h2 data-testid="account-handle">{handle}</h2>
        <p data-testid="primary-email">{email}</p>
        <p><code data-testid="account-did">{did}</code></p>
        <p>Your account data is hosted at {pdsUrl}.</p>
        <a href={url("about")}>What does this mean?</a>
      </div>
      <div class="account-destinations">
        {#each links.slice(1) as link (link.view)}
          <a
            class="account-destination"
            href={url(link.view)}
            id={link.view === "account"
              ? "identity"
              : link.view === "devices"
                ? "sessions"
                : undefined}
          >
            <span class="destination-icon" aria-hidden="true">
              <link.icon aria-hidden="true" size={24} />
            </span><span>
              <strong>{link.label}</strong><small>{link.description}</small>
            </span><ChevronRight aria-hidden="true" size={20} />
          </a>
        {/each}
      </div>
      <div class="legacy-anchors">
        <a id="recovery" href={`${url("account")}#recovery`}>
          Recovery email
        </a><a id="passwords" href={`${url("account")}#passwords`}>
          Account password
        </a><a id="lifecycle" href={`${url("account")}#lifecycle`}>
          Account lifecycle
        </a><a id="migration" href={`${url("account")}#migration`}>
          Data server
        </a>
      </div>
    {:else if view === "about"}
      <h2>About your account</h2>
      <p>
        Your account has a persistent DID and a handle. The DID identifies your
        account even if its handle changes.
      </p>
      <p>
        Your personal data server hosts your account repository at <strong>
          {pdsUrl}
        </strong>. Entryway manages your sign-in and account settings. Connected
        applications receive only the access you authorize.
      </p>
      <p>
        You can change your data server in <a
          href={`${url("account")}#migration`}
        >
          Account settings
        </a> when migration is available.
      </p>
    {:else}
      {@render content()}
    {/if}
  </div>
</div>
