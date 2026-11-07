import { z } from 'zod';
const metadata=z.object({count:z.number().int().min(0).max(2147483647),kind:z.string(),id:z.string().uuid()});
/** Only opaque delivery identity and an aggregate count leave the service. */
export function feedPushMetadata(raw:unknown){
 const parsed=metadata.safeParse(raw);
 if(!parsed.success)return null;
 const m=parsed.data;
 if(!["feed_activity","feed_badge"].includes(m.kind))return null;
 return {count:m.count,feed:m.kind==='feed_activity',badgeOnly:m.kind==='feed_badge',tag:m.kind==='feed_activity'?m.id.replaceAll('-',''):'porchday-update'};
}
