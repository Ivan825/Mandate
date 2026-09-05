// Outbound email. With RESEND_API_KEY set, magic links are sent through Resend
// from EMAIL_FROM; without it (local development) the link is printed to the
// server console so you can click it from the terminal.

export async function sendMagicLinkEmail(to: string, url: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`\n[mandate] Sign-in link for ${to}:\n${url}\n`);
    return;
  }
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const from = process.env.EMAIL_FROM ?? "Mandate <sign-in@mandate.local>";
  const { error } = await resend.emails.send({
    from,
    to,
    subject: "Your Mandate sign-in link",
    text: `Open this link to sign in to Mandate (valid for 15 minutes):\n\n${url}\n\nIf you didn't request this, ignore this email.`,
    html: `<p>Open this link to sign in to Mandate (valid for 15 minutes):</p><p><a href="${url}">${url}</a></p><p>If you didn't request this, ignore this email.</p>`,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}
