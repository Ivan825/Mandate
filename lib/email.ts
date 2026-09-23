// Outbound email: sign-in links and invitations. Delivery goes through
// lib/mailer.ts (Resend, SMTP, or the console in development).
import { sendMail } from "./mailer";

function esc(s: string) { return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!)); }

export async function sendMagicLinkEmail(to: string, url: string) {
  await sendMail({
    to,
    subject: "Your Mandate sign-in link",
    text: `Open this link to sign in to Mandate (valid for 15 minutes):\n\n${url}\n\nIf you didn't request this, ignore this email.`,
    html: `<p>Open this link to sign in to Mandate (valid for 15 minutes):</p><p><a href="${esc(url)}">${esc(url)}</a></p><p>If you didn't request this, ignore this email.</p>`,
  }, `Sign-in link for ${to}:\n${url}`);
}

export async function sendInvitationEmail(i: { to: string; inviter: string; workspace: string; role: string; url: string }) {
  await sendMail({
    to: i.to,
    subject: `${i.inviter} invited you to ${i.workspace} on Mandate`,
    text: `${i.inviter} invited you to the "${i.workspace}" workspace on Mandate as ${i.role}.\n\nAccept here (valid 7 days):\n${i.url}\n\nMandate gives AI agents scoped, revocable spending authority. If you weren't expecting this, ignore it.`,
    // Inviter and workspace names are user-typed: escaped, and no links except ours.
    html: `<p><strong>${esc(i.inviter)}</strong> invited you to the <strong>${esc(i.workspace)}</strong> workspace on Mandate as <strong>${esc(i.role)}</strong>.</p><p><a href="${esc(i.url)}">Accept the invitation</a> (valid 7 days)</p><p>Mandate gives AI agents scoped, revocable spending authority. If you weren't expecting this, ignore it.</p>`,
  }, `Invitation for ${i.to}:\n${i.url}`);
}
