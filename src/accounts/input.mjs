import { HttpError } from "../http/http-error.mjs";
import { accountEmailSchema } from "./input-schema.js";

export const fail = (error, message, status = 400) => {
  throw new HttpError(status, error, message);
};
export const emailAddress = (value) => {
  const result = accountEmailSchema.safeParse(value);
  if (!result.success) fail("InvalidEmail", "Provide a valid email address");
  return result.data;
};
