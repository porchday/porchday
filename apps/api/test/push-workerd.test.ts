import {describe, it, expect} from 'vitest';
import {createECDH, randomBytes} from 'node:crypto';
import {builtinModules} from 'node:module';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import webPush from 'web-push';

// Actual workerd fetch parsing matters: it does not accept redirect: 'error'.
// Every outbound request is intercepted; this test sends no provider traffic.
describe('Push requests in workerd', () => {
  it('uses native fetch and rejects provider redirects without forwarding credentials or ciphertext', async () => {
    const vapid = webPush.generateVAPIDKeys();
    const key = createECDH('prime256v1'); key.generateKeys();
    const bindings = {
      VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:push@example.test',
      APNS_TEAM_ID: 'TEAM123456', APNS_KEY_ID: 'KEY1234567', APNS_BUNDLE_ID: 'com.porchday.app',
      APNS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nsynthetic-test-only\n-----END PRIVATE KEY-----',
      SUBSCRIPTION: JSON.stringify({endpoint: 'https://fcm.googleapis.com/wp/synthetic-test', keys: {p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}}),
    };
    const bundle = await build({
      stdin: {contents: `
        import {webPushRequest} from './apps/api/src/social-push.ts';
        import {nativePushRequest,nativePushOutcome} from './apps/api/src/social-native-push.ts';
        export default {async fetch(_request,env) {
          const web = webPushRequest(JSON.parse(env.SUBSCRIPTION),env);
          const webResponse = await fetch(web.url,web.init);
          const webStatus = webResponse.status; await webResponse.body?.cancel();
          const native = nativePushRequest({token:'ab'.repeat(32),environment:'sandbox'},env,'synthetic-provider-token');
          const nativeResponse = await fetch(native.url,native.init);
          return Response.json({webStatus,native:await nativePushOutcome(nativeResponse,1)});
        }};`, resolveDir: process.cwd(), sourcefile: 'push-runtime-test.ts', loader: 'ts'},
      bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['browser', 'module', 'main'], conditions: ['workerd', 'browser'], external: ['node:*', 'cloudflare:*'], target: 'es2022',
      banner: {js: "import { createRequire } from 'node:module'; const require = createRequire('/push-test.js');"},
      plugins: [{name: 'node-builtins', setup(builder) {builder.onResolve({filter: /.*/}, args => builtinModules.includes(args.path) ? {path: args.path.startsWith('node:') ? args.path : 'node:' + args.path, external: true} : undefined);}}],
    });
    const calls: {host: string; authorization: string | null; bodyBytes: number}[] = [];
    const mf = new Miniflare(convertV4MiniflareOptions({name: 'push-runtime-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], bindings,
      outboundService: async (request: Request) => {
        calls.push({host: new URL(request.url).hostname, authorization: request.headers.get('authorization'), bodyBytes: (await request.arrayBuffer()).byteLength});
        return Response.json({reason: 'Unregistered'}, {status: 307, headers: {Location: 'https://attacker.test/capture'}});
      },
    }));
    try {
      const response = await mf.dispatchFetch('https://push-runtime.test/');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({webStatus: 307, native: {outcome: 'failed', delay: 30}});
      expect(calls.map(call => call.host)).toEqual(['fcm.googleapis.com', 'api.sandbox.push.apple.com']);
      expect(calls[0].authorization).toMatch(/^vapid t=/);
      expect(calls[1].authorization).toBe('bearer synthetic-provider-token');
      expect(calls.every(call => call.bodyBytes > 0)).toBe(true);
    } finally {await mf.dispose();}
  }, 30000);
});
