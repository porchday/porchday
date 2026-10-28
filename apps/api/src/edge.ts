import {app} from './index';
import type {Env} from './types';
import {event,normalizedRoute} from './telemetry';

/** Public requests retain the exact domain/security middleware at the edge.
 * API requests cross an internal service binding unchanged: the backend still
 * performs every origin, session, journal, revocation and RLS check. This
 * Worker has no database, storage, auth secrets, cron or queue consumer.
 */
export type EdgeEnv = Pick<Env, 'APP_URL' | 'LEGACY_APP_URL' | 'ENVIRONMENT' | 'ASSETS' | 'CF_VERSION_METADATA' | 'METRICS'> & {API_BACKEND: Fetcher};
export default {
 async fetch(request: Request, env: EdgeEnv, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api' || path.startsWith('/api/') || path === '/.well-known' || path.startsWith('/.well-known/')) {
   try { return await env.API_BACKEND.fetch(request); }
   catch {
    // Never retry a potentially accepted write or expose binding exceptions.
    event('error',{code:'request_failed'},env);
    event('request',{route:normalizedRoute(path),method:request.method,status:503},env);
    return Response.json({error:{code:'SERVICE_UNAVAILABLE',message:'Please try again shortly.'}},
     {status:503,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
   }
  }
  // Only the existing public branch of app executes here. Tests reject access
  // to any unbound private dependency, including on legacy/alias navigation.
  return app.fetch(request, env as unknown as Env, ctx);
 },
} satisfies ExportedHandler<EdgeEnv>;
