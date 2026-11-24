import ManagementRows from "./ManagementRows.svelte";
import AccountShell from "./AccountShell.svelte";
import AccountResult from "./AccountResult.svelte";
import { render } from "svelte/server";
import { createRawSnippet } from "svelte";
import type { ComponentProps } from "svelte";
import Identity from "./Identity.svelte";
import AccountError from "./AccountError.svelte";
import EmailStep from "./EmailStep.svelte";
import RecentLogin from "./RecentLogin.svelte";
import ProtectedPage from "./ProtectedPage.svelte";
import RecoveryPanel from "./RecoveryPanel.svelte";
import PasswordPanel from "./PasswordPanel.svelte";

export const renderIdentity = (props: ComponentProps<typeof Identity>) =>
  render(Identity, { props });
export const renderRecoveryPanel = (
  props: ComponentProps<typeof RecoveryPanel>,
) => render(RecoveryPanel, { props });
export const renderPasswordPanel = (
  props: ComponentProps<typeof PasswordPanel>,
) => render(PasswordPanel, { props });

export const renderProtectedPage = (
  props: ComponentProps<typeof ProtectedPage>,
) => render(ProtectedPage, { props });

export const renderRecentLogin = (props: ComponentProps<typeof RecentLogin>) =>
  render(RecentLogin, { props });

export const renderEmailStep = (props: ComponentProps<typeof EmailStep>) =>
  render(EmailStep, { props });

export const renderAccountError = (
  props: ComponentProps<typeof AccountError>,
) => render(AccountError, { props });

export const renderAccountResult = (
  props: ComponentProps<typeof AccountResult>,
) => render(AccountResult, { props });

export const renderAccountShell = (
  props: Omit<ComponentProps<typeof AccountShell>, "content"> & {
    content: string;
  },
) => {
  const content = createRawSnippet(() => ({
    render: () => `<div>${props.content}</div>`,
  }));
  return render(AccountShell, { props: { ...props, content } });
};

type ManagementContent =
  | "identity"
  | "handleForm"
  | "recovery"
  | "password"
  | "lifecycle"
  | "migration";
export const renderManagementRows = (
  props: Omit<ComponentProps<typeof ManagementRows>, ManagementContent> & {
    identity: string;
    handleForm: string;
    recovery: string;
    password: string;
    lifecycle: string;
    migration?: string;
  },
) => {
  const snippet = (html: string) =>
    createRawSnippet(() => ({ render: () => `<div>${html}</div>` }));
  return render(ManagementRows, {
    props: {
      email: props.email,
      handle: props.handle,
      passwordEnabled: props.passwordEnabled,
      identity: snippet(props.identity),
      handleForm: snippet(props.handleForm),
      recovery: snippet(props.recovery),
      password: snippet(props.password),
      lifecycle: snippet(props.lifecycle),
      ...(props.migration ? { migration: snippet(props.migration) } : {}),
    },
  });
};
