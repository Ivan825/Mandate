import { auth } from "@/lib/auth";

// RFC 8414 / RFC 9728 discovery must live at the site root; Better Auth
// serves everything under /api/auth, so hand these requests to it directly.
// The plugin matches on the original pathname, which is exactly what we pass.
export async function GET(request: Request) {
  return auth.handler(request);
}
export async function HEAD(request: Request) {
  return auth.handler(request);
}
