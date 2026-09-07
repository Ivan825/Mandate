import type { Instrumentation } from "next";

// Next calls this for every unhandled error in server components, route
// handlers, server actions and middleware. The reporter is loaded lazily so
// the edge bundle (middleware) stays free of Node-only modules.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./lib/errors");
  await reportError(err, { path: request.path, method: request.method, extra: { routerKind: context.routerKind, routePath: context.routePath, routeType: context.routeType } });
};
