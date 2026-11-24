export function getAuthorizedDevelopmentUserId(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim();
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!process.env.INTERNAL_DASHBOARD_TOKEN || token !== process.env.INTERNAL_DASHBOARD_TOKEN) return null;
  return "authenticated-dashboard-user";
}

export function unauthorized() {
  return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
}

export function rejectInvalidOrigin(request: Request) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return false;
  const origin = request.headers.get("origin");
  return Boolean(origin && origin !== appUrl.replace(/\/+$/, ""));
}
