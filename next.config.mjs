/** @type {import('next').NextConfig} */

// Security headers. The CSP allows inline scripts because Next's app router
// injects them without nonces; everything else is locked to self plus the
// one font host, plus Stripe.js (card details are rendered inside Stripe's
// own iframes; the top-up form redirects to Stripe Checkout). Nothing may
// frame us, and cross-origin agents talk to the JSON endpoints, not the pages.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://js.stripe.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://api.stripe.com",
  "frame-src https://js.stripe.com",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig = {
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/((?!api/).*)", headers: securityHeaders },
      // API responses carry no HTML; keep the non-CSP protections.
      { source: "/api/:path*", headers: securityHeaders.filter((h) => h.key !== "Content-Security-Policy") },
    ];
  },
};
export default nextConfig;
