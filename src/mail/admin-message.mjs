import { fail } from "../accounts/input.mjs";

export async function createAdminMessage({ mail }) {
  const sendEmail = async (
    row,
    { content, subject = "Message from your account service", senderDid },
  ) => {
    if (
      typeof content !== "string" ||
      !content ||
      content.length > 16_000 ||
      typeof senderDid !== "string"
    )
      fail("InvalidRequest", "Provide bounded email content and senderDid");
    if (
      typeof subject !== "string" ||
      !subject ||
      subject.length > 256 ||
      /[\r\n\0]/.test(subject)
    )
      fail("InvalidRequest", "Provide a bounded email subject");
    const sent = await mail.sendAdmin({
      email: row.email,
      subject,
      text: content,
    });
    return { sent };
  };
  return { sendEmail };
}
