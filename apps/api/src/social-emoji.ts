import type {Hono} from 'hono';
import {z} from 'zod';
import type {EncryptedEnvelope} from '@porchday/crypto';
import type {Db} from './db.js';
import {envelopeSchema} from './social-contract.js';
import type {RouteDependencies,SocialContext} from './social-media.js';
import type {Env,Variables} from './types.js';

interface Dependencies extends RouteDependencies {
  body<T>(c:SocialContext,schema:z.ZodType<T>,maxBytes?:number):Promise<T>;
  writeAllowed(db:Db):Promise<void>;
  checkEnvelope(db:Db,member:string,envelope:EncryptedEnvelope,kind:string,options?:{allowPast?:boolean}):Promise<unknown>;
}
const libraryBody=z.object({envelope:envelopeSchema.extend({ciphertext:z.string().startsWith('-----BEGIN PGP MESSAGE-----').max(3_000_000)})}).strict();

/** The collection is independent of the member's shared profile. No emoji name,
 * digest or image is visible to the service; only the owner's devices receive it. */
export function registerEmojiRoutes(app:Hono<{Bindings:Env;Variables:Variables}>,{tx,body,fail,writeAllowed,checkEnvelope}:Dependencies) {
  app.get('/emoji-library',async c=>c.json(await tx(c,async db=>{
    const [row]=await db`select envelope,revision from app.emoji_libraries where member_id=${c.get('memberId')}`;
    return row??{envelope:null,revision:0};
  })));
  app.put('/emoji-library',async c=>{
    const {envelope}=await body(c,libraryBody,3_200_000),member=c.get('memberId'),context=envelope.context;
    if(context.id!==member||context.audience!=='only_me'||context.parentId!==null||context.groupId!==null||context.expiresAt!==null)fail('ENVELOPE_CONTEXT');
    return c.json(await tx(c,async db=>{
      await writeAllowed(db);
      await checkEnvelope(db,member,envelope,'profile',{allowPast:true});
      // The directory lock in checkEnvelope serializes the initial insert too.
      const [old]=await db`select revision from app.emoji_libraries where member_id=${member} for update`;
      if(context.revision!==(old?.revision??0)+1)fail('REVISION_CHANGED',409);
      if(old)await db`update app.emoji_libraries set envelope=${db.json(envelope)},revision=${context.revision},updated_at=now() where member_id=${member}`;
      else await db`insert into app.emoji_libraries(member_id,envelope,revision) values(${member},${db.json(envelope)},${context.revision})`;
      return {ok:true,revision:context.revision};
    }));
  });
}
