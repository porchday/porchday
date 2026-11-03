import {shareAlbumHistory} from "./photo-album";
import { AlbumCover } from "./AlbumCover";
import type { PhotoRow } from "./photo-record";
import React, { useEffect, useRef, useState } from "react";
import type { Content, Device, EncryptedEnvelope, Json } from "./api";
import { get, post, request, del, items, message } from "./api";
import { useVault } from "./vault";
import { Alert, Button, Empty, Field, Icon, Loading, Modal, navigateAfterSaves, useAction } from "./ui";
export type AlbumRole = "read" | "add" | "admin";
export type AlbumRow = {photo_count?:number;cover?:PhotoRow|null;id:string;owner_id:string;envelope:EncryptedEnvelope;author_key:Device;revision:number;role:AlbumRole};
const roleLabels:Record<AlbumRole,string>={read:"Read-only",add:"Add",admin:"Album-admin"};
type DecodedAlbum = {row:AlbumRow;content:Content|null;error?:string};
export function Albums() {
  const vault=useVault(),action=useAction();
  const [albums,setAlbums]=useState<DecodedAlbum[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false);
  const mounted=useRef(false);
  const [creating,setCreating]=useState(false),[name,setName]=useState("");
  async function load(after?:string) {
    await action.run(async()=>{
      const result=await get("/albums"+(after?"?after="+encodeURIComponent(after):""));
      const decoded=await Promise.all(items<AlbumRow>(result).map(async row=>{
        try{return {row,content:await vault.open(row)};}catch(error){return {row,content:null,error:message(error)};}
      }));
      if(!mounted.current)return;
      setAlbums(old=>after?[...old,...decoded.filter(a=>!old.some(o=>o.row.id===a.row.id))]:decoded);
      setNext(result.next??null);setLoaded(true);
    });
  }
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;};},[vault.member.id]);
  async function create(e:React.FormEvent) {
    e.preventDefault();if(!name.trim())return;
    const created=await action.runSave(async()=>{
      const id=crypto.randomUUID();
      const envelope=await vault.seal({name:name.trim(),description:""},{id,kind:"album",audience:"only_me"});
      await post("/albums",{envelope});return id;
    });
    if(created)navigateAfterSaves("/app/albums/"+created);
  }
  return <>
    <div className="page-heading album-heading"><h1>Albums</h1>{vault.member.status==="active"&&<Button variant="primary" onClick={()=>setCreating(true)}><Icon name="plus"/>Create album</Button>}</div>
    <Alert>{action.error}</Alert>
    {!loaded&&action.busy?<Loading/>:<div className="album-grid">{albums.map(({row,content,error})=><a className="album-card panel" href={"/app/albums/"+row.id} key={row.id}><AlbumCover photo={row.cover}/><h2>{content?.name||"Encrypted album"}</h2><p>{row.photo_count||0} {(row.photo_count||0)===1?"photo":"photos"} · {roleLabels[row.role]}</p>{error&&<p>{error}</p>}</a>)}</div>}
    {loaded&&!albums.length&&<Empty icon="album" title="Make an album together">Create an album, add people and choose whether they can view, add photos or administer it.</Empty>}
    {next&&<Button busy={action.busy} onClick={()=>load(next)}>Load more albums</Button>}
    {creating&&<Modal title="Create album" onClose={()=>setCreating(false)}><form className="form-stack" onSubmit={create}><Field label="Album name" value={name} onChange={e=>setName(e.target.value)} maxLength={100} required/><p>You’ll be the album-admin. Add people after creating it.</p><Alert>{action.error}</Alert><Button type="submit" variant="primary" busy={action.busy} disabled={!name.trim()}>Create album</Button></form></Modal>}
  </>;
}
export function AlbumDetail({id,children}:{id:string;children?:(album:AlbumRow)=>React.ReactNode}) {
  const vault=useVault(),action=useAction();
  const [data,setData]=useState<{album:AlbumRow;members:Json[]}|null>(null),[content,setContent]=useState<Content|null>(null);
  const [name,setName]=useState(""),[people,setPeople]=useState(false),[choices,setChoices]=useState<Json[]>([]),[target,setTarget]=useState(""),[role,setRole]=useState<AlbumRole>("read");
  const [history,setHistory]=useState<string>("");
  const [confirm,setConfirm]=useState<"leave"|"delete"|string|null>(null);
  async function load(){const result=await get("/albums/"+id);const decoded=await vault.open(result.album);setData(result as typeof data);setContent(decoded);setName(String(decoded.name||""));}
  useEffect(()=>{let alive=true;void action.run(async()=>{const result=await get("/albums/"+id);const decoded=await vault.open(result.album);if(alive){setData(result as typeof data);setContent(decoded);setName(String(decoded.name||""));}});return()=>{alive=false;};},[id,vault.member.id]);
  async function showPeople(){setPeople(!people);if(people)return;await action.run(async()=>{const connections=await get("/connections");const ids=new Set(items<Json>(connections).map(c=>c.member_a===vault.member.id?c.member_b:c.member_a));setChoices((connections.handles||[]).map((h:Json)=>({...h,id:h.id||h.member_id})).filter((h:Json)=>ids.has(h.id)));});}
  async function changeMember(memberId:string,nextRole:AlbumRole|null){if(!data||!content)return;await action.runSave(async()=>{
    const envelope=await vault.sealAlbum(content,{...data.album.envelope.context,revision:data.album.revision+1},{memberId,role:nextRole});
    await request(`/albums/${id}/members/${memberId}`,{method:"PUT",body:JSON.stringify({envelope,role:nextRole,expected_revision:data.album.revision})});
    const added=nextRole!==null&&!data.members.some(m=>m.member_id===memberId);
    setTarget("");await load();if(added){try{await refreshHistory();}catch{setHistory("Album permissions were saved, but sharing existing photos stopped. Use Share existing photos to retry.");}}
  },"Album permissions updated.");}
  async function refreshHistory(){
    setHistory("Sharing existing photos…");
    const result=await shareAlbumHistory(vault,id,(done,failed)=>setHistory(`${done} photos shared${failed?`; ${failed} need a retry`:""}…`));
    setHistory(`${result.done} photos shared with current eligible members. ${result.failed?`${result.failed} could not be shared; restore your photo keys or retry after membership changes settle.`:""} Only photos you can decrypt were included. An admin with the original photo keys may need to share older photos you cannot see.`);
  }
  async function shareHistory(){await action.runSave(refreshHistory);}
  async function rename(){if(!data||!content||!name.trim())return;await action.runSave(async()=>{
    const envelope=await vault.sealAlbum({...content,name:name.trim()},{...data.album.envelope.context,revision:data.album.revision+1});
    await request("/albums/"+id,{method:"PUT",body:JSON.stringify({envelope,expected_revision:data.album.revision})});await load();
  },"Album updated.");}
  const admin=data?.album.role==="admin",owner=data?.album.owner_id===vault.member.id,canWrite=vault.member.status==="active";
  return <>
    <a className="text-link" href="/app/albums">← Albums</a><Alert>{action.error}</Alert><Alert success>{action.notice}</Alert>
    {!data||!content?(!action.error&&<Loading/>):<>
      <div className="page-heading"><h1>{String(content.name||"Album")}</h1><p>{data.members.length} people · {roleLabels[data.album.role]}</p></div>
      <div className="album-actions">{data.album.role!=="read"&&canWrite&&<a className="button primary" href={"/app/share?album="+id}>Add photos <Icon name="plus"/></a>}<Button onClick={showPeople}>People & permissions</Button></div>
      {data.album.role!=="read"&&<p className="muted">Add photos opens Share → Photos Only.</p>}
      {people&&<section className="panel form-stack"><h2>People & permissions</h2><p>Album members can view its photos. A photo’s existing audience keeps access too.</p>
        {data.members.map(m=><div className="album-member" key={m.member_id}><span>{m.member_id===vault.member.id?"You":"@"+m.handle}{m.member_id===data.album.owner_id?" · owner":""}</span>
          {admin&&canWrite&&m.member_id!==data.album.owner_id&&m.member_id!==vault.member.id?<><select aria-label={"Role for @"+m.handle} value={m.role} disabled={action.busy} onChange={e=>changeMember(m.member_id,e.target.value as AlbumRole)}>{Object.entries(roleLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select><Button variant="outline compact" disabled={action.busy} onClick={()=>changeMember(m.member_id,null)}>Remove</Button></>:<span>{roleLabels[m.role as AlbumRole]}</span>}
        </div>)}
        {admin&&canWrite&&<><label>Add a connection<select value={target} onChange={e=>setTarget(e.target.value)}><option value="">Choose a person</option>{choices.filter(c=>!data.members.some(m=>m.member_id===c.id)).map(c=><option key={c.id} value={c.id}>@{c.handle}</option>)}</select></label><label>Role<select value={role} onChange={e=>setRole(e.target.value as AlbumRole)}>{Object.entries(roleLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><Button disabled={!target} busy={action.busy} onClick={()=>changeMember(target,role)}>Add person</Button>
          <p>Adding a person also shares earlier photos you can decrypt. Use Share existing photos to retry or share history after restoring your keys. A photo's other audiences are unchanged; blocked people remain excluded.</p>
          <Button busy={action.busy} onClick={shareHistory}>Share existing photos</Button><p role="status">{history}</p>
          <Field label="Album name" value={name} maxLength={100} onChange={e=>setName(e.target.value)}/><Button disabled={!name.trim()||name===content.name} busy={action.busy} onClick={rename}>Save name</Button></>}
        {owner&&canWrite?<><Button variant="outline" onClick={()=>setConfirm("delete")}>Delete album</Button>{data.members.filter(m=>m.member_id!==vault.member.id&&m.role==="admin").map(m=><Button key={m.member_id} onClick={()=>setConfirm(m.member_id)}>Transfer ownership to @{m.handle}</Button>)}</>:canWrite&&<Button variant="outline" onClick={()=>setConfirm("leave")}>Leave album</Button>}
      </section>}
      {children?.(data.album)}
    </>}
    {confirm&&<Modal title={confirm==="delete"?"Delete album?":confirm==="leave"?"Leave album?":"Transfer album ownership?"} onClose={()=>setConfirm(null)}><p>{confirm==="delete"?"This removes the album and its access grants. Photos keep any access they have outside this album.":confirm==="leave"?"You’ll lose access supplied by this album. Other photo access is unchanged.":"The new owner will control deletion and future ownership transfers. You remain an album-admin."}</p><Button busy={action.busy} onClick={async()=>{const destination=await action.runSave(async()=>{if(confirm==="delete")await del("/albums/"+id);else if(confirm==="leave")await post(`/albums/${id}/leave`,{});else await post(`/albums/${id}/transfer`,{member_id:confirm});if(confirm==="leave"||confirm==="delete")return "/app/albums";setConfirm(null);await load();});if(destination)navigateAfterSaves(destination);}}>Confirm</Button><Alert>{action.error}</Alert></Modal>}
  </>;
}
