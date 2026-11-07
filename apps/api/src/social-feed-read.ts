import type { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from './db';
import type { SocialContext } from './social-media';
import type { Env, Variables } from './types';
export const feedReadBatch = z.object({items:z.array(z.object({kind:z.enum(['post','photo']),id:z.string().uuid()}).strict()).max(100)}).strict();
type Dependencies={tx<T>(c:SocialContext,fn:(db:Db)=>Promise<T>):Promise<T>;body<T>(c:SocialContext,schema:z.ZodType<T>,maxBytes?:number):Promise<T>};
export function registerFeedReadRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,body}:Dependencies){
 app.get('/feed/unread',async c=>c.json(await tx(c,async db=>{const [r]=await db`select app.feed_unread_state() as state`;return r.state;})));
 app.put('/feed/read',async c=>{const b=await body(c,feedReadBatch,10000);return c.json(await tx(c,async db=>{const [r]=await db`select app.mark_feed_read(${db.json(b.items)},false) as state`;return r.state;}));});
 app.put('/feed/read-all',async c=>{await body(c,z.object({}).strict(),100);return c.json(await tx(c,async db=>{const [r]=await db`select app.mark_feed_read('[]'::jsonb,true) as state`;return r.state;}));});
}
