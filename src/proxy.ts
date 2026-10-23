import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function redirectWithSession(
  request: NextRequest,
  path: string,
  sessionResponse: NextResponse,
) {
  const destination = request.nextUrl.clone();
  destination.pathname = path;
  destination.search = "";

  const redirectResponse = NextResponse.redirect(destination);
  for (const cookie of sessionResponse.cookies.getAll()) {
    redirectResponse.cookies.set(cookie);
  }

  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = sessionResponse.headers.get(header);
    if (value) redirectResponse.headers.set(header, value);
  }

  return redirectResponse;
}

export async function proxy(request: NextRequest) {
  let sessionResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, cacheHeaders) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          sessionResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => {
            sessionResponse.cookies.set(name, value, options);
          });
          Object.entries(cacheHeaders).forEach(([name, value]) => {
            sessionResponse.headers.set(name, value);
          });
        },
      },
    },
  );

  // Refresh before reading claims so the request and response share fresh cookies.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims);
  const pathname = request.nextUrl.pathname;

  if (!isSignedIn && pathname.startsWith("/dashboard")) {
    return redirectWithSession(request, "/sign-in", sessionResponse);
  }

  if (isSignedIn && pathname === "/sign-in") {
    return redirectWithSession(request, "/dashboard", sessionResponse);
  }

  return sessionResponse;
}

export const config = {
  matcher: ["/sign-in", "/dashboard/:path*"],
};
