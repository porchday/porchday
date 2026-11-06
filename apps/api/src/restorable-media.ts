import type {Sql,ReservedSql} from 'postgres';

/** Operator-only inventory. Supports snapshots predating segmented videos. */
export async function restorableMediaPage(sql:Sql|ReservedSql,after='',key:string|null=null){
 const [schema]=await sql`select to_regclass('app.video_chunks') is not null as videos`;
 const chunks=schema.videos?sql`union all
  select c.object_key,c.sha256 as envelope_sha256,c.sha256 as raw_sha256,c.byte_size
  from app.video_chunks c join app.video_streams s on s.id=c.stream_id
  where s.complete and c.received_at is not null
   and not exists(select from app.deletion_outbox d where d.object_key=c.object_key)
   and exists(select from app.media_assets m where m.video_stream_id=s.id and m.state in('ready','attached') and(app.media_deadline(m.id) is null or app.media_deadline(m.id)>now()))`:sql``;
 return sql`select * from (
  select object_key,envelope_sha256,raw_sha256,byte_size from app.media_assets
  where state in('ready','attached') and(app.media_deadline(id) is null or app.media_deadline(id)>now())
  ${chunks}
 ) inventory where object_key>${after} and(${key}::text is null or object_key=${key}) order by object_key limit 50`;
}
