// One place that sends email. Two transports, chosen by environment:
//   RESEND_API_KEY            Resend (needs a verified domain you own)
//   SMTP_URL                  any SMTP server, e.g. Gmail with an app password:
//                             smtps://you%40gmail.com:app-password@smtp.gmail.com:465
// Neither set: the message is printed to the server console (development).

export type Mail = { to: string; subject: string; text: string; html: string };

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY || process.env.SMTP_URL);
}

export function emailFrom(): string {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  const smtp = process.env.SMTP_URL;
  if (smtp) { try { const u = new URL(smtp); if (u.username) return `Mandate <${decodeURIComponent(u.username)}>`; } catch { /* fall through */ } }
  return "Mandate <sign-in@mandate.local>";
}

export async function sendMail(m: Mail, consoleNote?: string): Promise<void> {
  if (process.env.RESEND_API_KEY) {
    const { Resend } = await import("resend");
    const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: emailFrom(), to: m.to, subject: m.subject, text: m.text, html: m.html });
    if (error) throw new Error(`Resend: ${error.message}`);
    return;
  }
  if (process.env.SMTP_URL) {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(process.env.SMTP_URL);
    await transport.sendMail({ from: emailFrom(), to: m.to, subject: m.subject, text: m.text, html: m.html });
    return;
  }
  console.log(`\n[mandate] Email to ${m.to}: ${m.subject}\n${consoleNote ?? m.text}\n`);
}
