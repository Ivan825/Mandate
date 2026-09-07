// Outbound email. With RESEND_API_KEY set, magic links are sent through Resend
// from EMAIL_FROM; without it (local development) the link is printed to the
// server console so you can click it from the terminal.

function esc(s: string) { return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!)); }

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
    html: `<p>Open this link to sign in to Mandate (valid for 15 minutes):</p><p><a href="${esc(url)}">${esc(url)}</a></p><p>If you didn't request this, ignore this email.</p>`,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}

export async function sendInvitationEmail(i: { to: string; inviter: string; workspace: string; role: string; url: string }) {
  const key = process.env.RESEND_API_KEY;
  const text = `${i.inviter} invited you to the "${i.workspace}" workspace on Mandate as ${i.role}.\n\nAccept here (valid 7 days):\n${i.url}\n\nMandate gives AI agents scoped, revocable spending authority. If you weren't expecting this, ignore it.`;
  if (!key) { console.log(`\n[mandate] Invitation for ${i.to}:\n${i.url}\n`); return; }
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM ?? "Mandate <sign-in@mandate.local>",
    to: i.to,
    subject: `${i.inviter} invited you to ${i.workspace} on Mandate`,
    text,
    // Inviter and workspace names are user-typed: escaped, and no links except ours.
    html: `<p><strong>${esc(i.inviter)}</strong> invited you to the <strong>${esc(i.workspace)}</strong> workspace on Mandate as <strong>${esc(i.role)}</strong>.</p><p><a href="${esc(i.url)}">Accept the invitation</a> (valid 7 days)</p><p>Mandate gives AI agents scoped, revocable spending authority. If you weren't expecting this, ignore it.</p>`,
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}
