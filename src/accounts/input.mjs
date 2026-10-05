import { HttpError } from "../http/http-error.mjs";

export const fail = (error, message, status = 400) => {
  throw new HttpError(status, error, message);
};
export const emailAddress = (value) => {
  const email = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    fail("InvalidEmail", "Provide a valid email address");
  return email;
};
