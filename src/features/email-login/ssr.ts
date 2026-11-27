import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import EmailForm from "./EmailForm.svelte";
import CodeForm from "./CodeForm.svelte";

export function renderEmailForm(props: ComponentProps<typeof EmailForm>) {
  const { body, head } = render(EmailForm, { props });
  return { body, head };
}

export function renderCodeForm(props: ComponentProps<typeof CodeForm>) {
  const { body, head } = render(CodeForm, { props });
  return { body, head };
}
