import { z } from 'zod';
const metadata=z.object({count:z.number().int().min(0).max(2147483647),kind:z.string(),id:z.string().uuid()});
const preview=z.object({author:z.string().regex(/^[a-z0-9_]{3,24}$/),content:z.enum(['post','media'])});
/** Public handles and activity type only; encrypted content never enters push. */
export function feedPushMetadata(raw:unknown){
 const parsed=metadata.safeParse(raw);
 if(!parsed.success)return null;
 const m=parsed.data;
 if(!["feed_activity","feed_badge"].includes(m.kind))return null;
 const details=m.kind==='feed_activity'?preview.safeParse(raw):null;
 return {count:m.count,feed:m.kind==='feed_activity',badgeOnly:m.kind==='feed_badge',tag:m.kind==='feed_activity'?m.id.replaceAll('-',''):'porchday-update',
  ...(details?.success?{author:details.data.author,content:details.data.content}:{})};
}
export function feedPushBody(feed:NonNullable<ReturnType<typeof feedPushMetadata>>){
 if(!feed.feed)return 'You have a new update';
 if(feed.author)return `@${feed.author} shared ${feed.content==='post'?'a post':'photos/videos'}`;
 return 'New activity in your feed';
}
