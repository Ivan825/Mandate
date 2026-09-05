"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient, organizationClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), organizationClient(), passkeyClient(), oauthProviderClient()],
});
