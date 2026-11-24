import { render } from "svelte/server";
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
