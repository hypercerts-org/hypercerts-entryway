import { fail, emailAddress } from "../../accounts/input.mjs";

export async function createSignupProof({ sendCode, requireCode }) {
  const requestSignup = async ({ email }) =>
    await sendCode("signup", emailAddress(email), emailAddress(email));
  const verifySignup = async ({ email, token }) =>
    await requireCode("signup", emailAddress(email), token);
  const requestPhoneVerification = async ({ phoneNumber }) => {
    if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber ?? ""))
      fail("InvalidPhoneNumber", "Use an E.164 phone number");
    return await sendCode(
      "phone-verification",
      phoneNumber,
      phoneNumber,
      "sms",
    );
  };
  const verifyPhone = async ({ phoneNumber, token }) =>
    await requireCode("phone-verification", phoneNumber, token);
  return { requestSignup, verifySignup, requestPhoneVerification, verifyPhone };
}
