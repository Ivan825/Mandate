import { auth } from "@/lib/auth";

// RFC 8414 / RFC 9728 discovery must live at the site root; Better Auth
// serves everything under /api/auth, so hand these requests to it directly.
// The plugin matches on the original pathname, which is exactly what we pass.
//
// The issuer is `<APP_URL>/api/auth`, so the spec-correct metadata path is
// /.well-known/oauth-authorization-server/api/auth (served by the plugin).
// Older MCP clients skip protected-resource discovery and fetch the bare
// root path instead; answer those with the same document.
const ROOT_ALIASES: Record<string, string> = {
  "/.well-known/oauth-authorization-server": "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/openid-configuration": "/.well-known/oauth-authorization-server/api/auth",
};

function normalise(request: Request): Request {
  const url = new URL(request.url);
  const target = ROOT_ALIASES[url.pathname.replace(/\/+$/, "")];
  if (!target) return request;
  url.pathname = target;
  return new Request(url, request);
}

export async function GET(request: Request) {
  return auth.handler(normalise(request));
}
export async function HEAD(request: Request) {
  return auth.handler(normalise(request));
}
