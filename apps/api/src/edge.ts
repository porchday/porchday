import {createOperationTrace,parseTraceparent,causalSpan,causalTraceparent} from './causal-tracing';
import {app} from './index';
import type {Env} from './types';
import {event,normalizedRoute} from './telemetry';

/** Public requests retain the exact domain/security middleware at the edge.
 * API requests cross an internal service binding unchanged: the backend still
 * performs every origin, session, journal, revocation and RLS check. This
 * Worker has no application database, media storage, auth secrets, cron or queue consumer.
 * Its optional D1 binding stores sanitized operational traces only.
 */
export type EdgeEnv = Pick<Env, 'APP_URL' | 'LEGACY_APP_URL' | 'ENVIRONMENT' | 'ASSETS' | 'CF_VERSION_METADATA' | 'METRICS' | 'TRACES' | 'OPERATIONAL_TRACING'> & {API_BACKEND: Fetcher};
export default {
 async fetch(request: Request, env: EdgeEnv, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/api' || path.startsWith('/api/') || path === '/.well-known' || path.startsWith('/.well-known/')) {
   const trace=createOperationTrace(env,parseTraceparent(request.headers.get('traceparent')),task=>ctx.waitUntil(task),'http','edge');
   const forward=()=>causalSpan('http.backend',()=>{const parent=causalTraceparent();if(!parent)return env.API_BACKEND.fetch(request);const headers=new Headers(request.headers);headers.set('traceparent',parent);return env.API_BACKEND.fetch(new Request(request,{headers}));});
   try { const response=trace?await trace.run(forward):await forward();trace?.finish(response.status,normalizedRoute(path));return response; }
   catch {
    trace?.finish(503,normalizedRoute(path));
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
