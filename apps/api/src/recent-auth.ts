import type {Context} from 'hono';
import {generateSignedCookie,getSignedCookie} from 'hono/cookie';
import type {Env,Variables} from './types';
type C=Context<{Bindings:Env;Variables:Variables}>;
const lifetime=15*60_000;
const name=(c:C)=>(c.env.APP_URL.startsWith('https:')?'__Secure-':'')+'porchday.recovery_confirmation';
export async function recoveryConfirmationCookie(c:C,memberId:string,sessionId:string){
 const now=Date.now();return generateSignedCookie(name(c),JSON.stringify({v:1,memberId,sessionId,at:now,expires:now+lifetime}),c.env.BETTER_AUTH_SECRET,{httpOnly:true,secure:c.env.APP_URL.startsWith('https:'),sameSite:'strict',path:'/api/v1',maxAge:lifetime/1000});
}
/** A confirmation never authenticates a session itself or extends its expiry. */
export async function recoveryAuthTime(c:C,memberId:string,sessionId:string,createdAt:number){
 if(!/^\/api\/v1\/(?:keys\/backup|devices(?:\/challenge|\/[a-f0-9-]{36})?)$/.test(c.req.path))return createdAt;
 const raw=await getSignedCookie(c,c.env.BETTER_AUTH_SECRET,name(c));if(!raw)return createdAt;
 try{const grant=JSON.parse(raw),now=Date.now();if(grant.v===1&&grant.memberId===memberId&&grant.sessionId===sessionId&&Number.isSafeInteger(grant.at)&&grant.at<=now&&grant.at>now-lifetime&&grant.expires===grant.at+lifetime)return Math.max(createdAt,grant.at);}catch{/* Invalid grants never relax the sign-in freshness gate. */}
 return createdAt;
}
