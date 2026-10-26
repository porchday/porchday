import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from './types';

type PauseFlag = 'CONTENT_WRITES_PAUSED' | 'MEDIA_UPLOADS_PAUSED' | 'SOCIAL_INVITATIONS_PAUSED';
const controls: { flag: PauseFlag; code: string; message: string; routes: [string, RegExp][] }[] = [
  {
    flag: 'MEDIA_UPLOADS_PAUSED', code: 'UPLOADS_PAUSED',
    message: 'Photo uploads are temporarily paused. Keep your draft and try again later.',
    routes: [['POST', /^\/api\/v1\/media$/], ['PUT', /^\/api\/v1\/media\/[^/]+\/bytes$/]],
  },
  {
    flag: 'SOCIAL_INVITATIONS_PAUSED', code: 'INVITATIONS_PAUSED',
    message: 'Invitations are temporarily paused. Please try again later.',
    routes: [
      ['POST', /^\/api\/v1\/platform-invitations$/],
      ['POST', /^\/api\/v1\/connections\/requests(?:\/[^/]+\/accept)?$/],
      ['POST', /^\/api\/v1\/groups\/[^/]+\/invitations$/],
      ['POST', /^\/api\/v1\/group-invitations\/[^/]+\/accept$/],
    ],
  },
  {
    flag: 'CONTENT_WRITES_PAUSED', code: 'POSTING_PAUSED',
    message: 'Posting and editing are temporarily paused. Keep your draft and try again later.',
    routes: [
      ['POST', /^\/api\/v1\/(?:posts|groups|imports)$/],
      ['POST', /^\/api\/v1\/posts\/[^/]+\/(?:comments|reshare)$/],
      ['PUT', /^\/api\/v1\/profiles\/me$/],
      ['PUT', /^\/api\/v1\/emoji-library$/],
      ['PUT', /^\/api\/v1\/(?:posts|comments|groups)\/[^/]+$/],
      ['PUT', /^\/api\/v1\/(?:posts|comments)\/[^/]+\/reactions\/[^/]+$/],
      ['PUT', /^\/api\/v1\/media\/[^/]+\/attachment$/],
    ],
  },
];

// Mount after member authentication and before journal/mutation handlers.
// This is a selective write pause, not a substitute for privacy quarantine.
export const incidentControls: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  for (const control of controls) {
    if (c.env[control.flag] !== 'true') continue;
    if (!control.routes.some(([method, path]) => method === c.req.method && path.test(c.req.path))) continue;
    c.header('Cache-Control', 'private, no-store');
    c.header('Retry-After', '60');
    return c.json({ error: { code: control.code, message: control.message } }, 503);
  }
  await next();
};
