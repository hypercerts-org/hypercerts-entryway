import { fail } from "../accounts/input.mjs";

export async function createAdminMessage({ db }) {
  const sendEmail = async (
    row,
    {
      content,
      subject = "Message from your account service",
      senderDid,
      comment,
    },
  ) => {
    if (
      typeof content !== "string" ||
      !content ||
      content.length > 16_000 ||
      typeof senderDid !== "string"
    )
      fail("InvalidRequest", "Provide bounded email content and senderDid");
    await db.set("mail-outbox", crypto.randomUUID(), {
      email: row.email,
      recipientDid: row.did,
      content,
      subject,
      senderDid,
      comment,
      createdAt: new Date(),
    });
    return { sent: true };
  };
  return { sendEmail };
}
