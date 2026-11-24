import { render } from "svelte/server";
import type { ComponentProps } from "svelte";
import HandleForm from "./HandleForm.svelte";

export const renderHandleForm = (props: ComponentProps<typeof HandleForm>) =>
  render(HandleForm, { props });
