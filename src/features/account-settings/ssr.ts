import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import Identity from "./Identity.svelte";
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
