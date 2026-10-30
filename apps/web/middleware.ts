import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfigured } from "./lib/env";

// Every page needs a signed-in user except the landing page and the OAuth callback.
const authkit = authConfigured()
  ? authkitMiddleware({
      middlewareAuth: { enabled: true, unauthenticatedPaths: ["/", "/callback"] },
    })
  : null;

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  // Without WorkOS settings the landing page explains what to configure; nothing else is reachable.
  if (!authkit) {
    return req.nextUrl.pathname === "/"
      ? NextResponse.next()
      : NextResponse.redirect(new URL("/", req.url));
  }
  return authkit(req, event);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
