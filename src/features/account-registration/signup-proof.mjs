import { fail, emailAddress } from "../../accounts/input.mjs";

export async function createSignupProof({ sendCode, requireCode }) {
  const requestSignup = ({ email }) =>
    sendCode("signup", emailAddress(email), emailAddress(email));
  const verifySignup = ({ email, token }) =>
    requireCode("signup", emailAddress(email), token);
  const requestPhoneVerification = ({ phoneNumber }) => {
    if (!/^\+[1-9][0-9]{7,14}$/.test(phoneNumber ?? ""))
      fail("InvalidPhoneNumber", "Use an E.164 phone number");
    return sendCode("phone-verification", phoneNumber, phoneNumber, "sms");
  };
  const verifyPhone = ({ phoneNumber, token }) =>
    requireCode("phone-verification", phoneNumber, token);
  return { requestSignup, verifySignup, requestPhoneVerification, verifyPhone };
}
