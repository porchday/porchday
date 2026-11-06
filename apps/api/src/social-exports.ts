import type { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from './types.js';
import type { RouteDependencies, SocialContext } from './social-media.js';

const sections=['profile','emoji_library','posts','comments','post_reactions','comment_reactions','media','connections','groups','photos','albums','attachment_dates','photo_interactions'] as const;
const sectionSchema=z.enum(sections);
const validationSchema=z.object({items:z.array(z.object({kind:z.enum(['profile','emoji_library','post','comment','post_reaction','comment_reaction','media','photo','album','attachment_date','photo_interaction']),id:z.string().min(1).max(256),revision:z.number().int().positive(),expires_at:z.string().datetime({offset:true}).nullable()} ).strict()).max(1000)}).strict();
export function registerExportRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,recent,fail,id}:RouteDependencies&{recent(c:SocialContext):void}) {
  app.post('/exports',async c=>{recent(c);return c.json(await tx(c,async db=>{
    const [job]=await db`insert into app.data_transfer_jobs(id,member_id,kind,state) values(${crypto.randomUUID()},${c.get('memberId')},'export','complete') returning id,expires_at`;return {...job,sections};
  }),201);});
  app.get('/exports/:id',async c=>{
    recent(c);const section=c.req.query('section');const cursor=c.req.query('cursor')??'';
    if(cursor.length>256)fail('INVALID_CURSOR');
    return c.json(await tx(c,async db=>{
      if(section){const [row]=await db`select app.export_page(${id(c.req.param('id'))},${sectionSchema.parse(section)},${cursor}) as page`;return row.page;}
      // Manifest discovery is bounded. Every content section must be paged explicitly.
      const [row]=await db`select app.export_page(${id(c.req.param('id'))},'profile','') as page`;
      return {...row.page,sections,schema_version:1};
    }));
  });
  app.post('/exports/:id/validate',async c=>{
    recent(c);const raw=await c.req.text();if(new TextEncoder().encode(raw).length>512_000)fail('PAYLOAD_TOO_LARGE',413);
    const b=validationSchema.parse(JSON.parse(raw));
    return c.json(await tx(c,async db=>{const [r]=await db`select app.validate_export(${id(c.req.param('id'))},${db.json(b.items)}) as valid`;if(!r.valid)fail('EXPORT_CHANGED',409);return {ok:true};}));
  });
  app.get('/exports/:id/media/:mediaId/bytes',async c=>{
    recent(c);const key=await tx(c,async db=>{const [r]=await db`select app.export_media(${id(c.req.param('id'))},${id(c.req.param('mediaId'))}) as object_key`;const[m]=await db`select video_stream_id from app.media_assets where id=${id(c.req.param('mediaId'))}`;if(m?.video_stream_id&&c.req.query('video_version')!=='2')fail('CLIENT_UPDATE_REQUIRED',409);return r.object_key;});
    const object=await c.env.MEDIA.get(key);if(!object)return fail('NOT_FOUND',404);
    return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  });
  app.get('/exports/:id/media/:mediaId/chunks/:index',async c=>{
    recent(c);const index=Number(c.req.param('index'));if(!Number.isSafeInteger(index)||index<0||index>62)fail('NOT_FOUND',404);
    const chunk=await tx(c,async db=>{
      await db`select app.export_media(${id(c.req.param('id'))},${id(c.req.param('mediaId'))})`;
      const[row]=await db`select v.object_key,v.byte_size from app.video_chunks v join app.media_assets m on m.video_stream_id=v.stream_id where m.id=${id(c.req.param('mediaId'))} and v.chunk_index=${index} and v.received_at is not null and app.can_video_stream(v.stream_id)`;
      if(!row)fail('NOT_FOUND',404);return row;
    });
    const object=await c.env.MEDIA.get(chunk.object_key);if(!object||object.size!==Number(chunk.byte_size))return fail('NOT_FOUND',404);
    return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Length':String(chunk.byte_size)}});
  });
  app.delete('/exports/:id',async c=>c.json(await tx(c,async db=>{await db`update app.data_transfer_jobs set state='cancelled' where id=${id(c.req.param('id'))} and kind='export'`;return {ok:true};})));
}
