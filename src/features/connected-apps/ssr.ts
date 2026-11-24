import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import ConnectedApps from "./ConnectedApps.svelte";
import AppPasswordResult from "./AppPasswordResult.svelte";
import AppPasswords from "./AppPasswords.svelte";
import AppPasswordForm from "./AppPasswordForm.svelte";

export const renderConnectedApps = (
  props: ComponentProps<typeof ConnectedApps>,
) => render(ConnectedApps, { props });
export const renderAppPasswords = (
  props: ComponentProps<typeof AppPasswords>,
) => render(AppPasswords, { props });
export const renderAppPasswordForm = (
  props: ComponentProps<typeof AppPasswordForm>,
) => render(AppPasswordForm, { props });

export const renderAppPasswordResult = (
  props: ComponentProps<typeof AppPasswordResult>,
) => render(AppPasswordResult, { props });
