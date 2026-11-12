import {CachedEncryptedPhoto} from "./CachedEncryptedPhoto";
import {causeOf} from './causal-links';
import {PostText} from "./PostText";
import {ReactionChips} from "./ReactionChips";
import {prepareNotificationPreview} from './notification-previews';
import {usePostDraft,type PendingPhoto} from './use-post-draft';
import {SharedMediaInbox} from './SharedMediaInbox';
import {photoCaptureDate} from './media-date';
import {stagePhotoVideo} from './photo-video';
import {videoUpdatePlaceholder} from "./video-placeholder";
import {validateVideoManifest} from "@porchday/crypto/video";
import {VideoPicker} from "./VideoPicker";
import type {PreparedLargeVideo} from "./video-prepare";
import {stageVideo,stageMedia,savePublication,sendPublication,pendingPublications,cancelPublication,discardLocalPublication} from "./video-outbox";
import {SegmentedVideo} from "./SegmentedVideo";
import {ActivityAuthor,postAudienceLabel} from "./ActivityAuthor";
import {PhotoViewer} from "./PhotoViewer";
import {AttachmentDateEditor} from "./AttachmentDateEditor";
import {signAttachmentDate} from "./attachment-photo-date";
import {verifyPhotoBytes,type PhotoProof} from "@porchday/crypto/photos";
import { publishPhoto, localPhotoDate } from "./photo-publish";
import { matchesAuthor, matchesContent, type AuthorFilter, type FeedContent } from "./feed-filters";
import { isVideo, VIDEO_ACCEPT, prepareVideo, validatedMedia } from "./video";
import {TagPicker, Tags, validTags, useMentionResolver, usePeopleDirectory, type PersonTag} from "./PeopleTags";
import { useNearViewport } from "./near-viewport";
import { MemberAvatar } from "./MemberAvatar";
import React, { useEffect, useRef, useState } from "react";
import {
  bytesToBase64,
  base64ToBytes,
  createReactionSecret,
  reactionTag,
  signStatement,
  type Audience,
  type EncryptedEnvelope,
} from "@porchday/crypto";
import {
  ApiError,
  get,
  post,
  patch,
  del,
  request,
  items,
  deadline,
  localDate,
  relativeDate,
  remaining,
  message,
  unexpired,
  accessLost,
  type SocialObject,
  type Content,
  type MediaPayload,
  type Json,
} from "./api";
import {
  Alert,
  Button,
  Empty,
  Field,
  Icon,
  Loading,
  Modal,
  useAction,
  navigateAfterSaves,
} from "./ui";
import { useVault } from "./vault";
import { reshareDeadline, resharePayload } from "./reshare";
import {
  jpegDimensions,
  jpegSource,
  PHOTO_ACCEPT,
  PHOTO_SOURCE_MAX_BYTES,
  photoSourceMime,
  stripCanvasJpegMetadata,
  validatedPhoto,
} from "./photo-safety";
import { preservedPhotoDeadline } from "./archive";
import {
  validateReactionPayload,
  reactionDisplay,
  type ReactionPayload,
} from "@porchday/crypto/reactions";
import { EmojiGlyph, EmojiPicker } from "./EmojiPicker";
import { decodeReactions, type DecodedReaction } from "./reaction-read";
import { validateCustomEmojiPixels } from "./emoji-images";
import type { CustomEmoji } from "./emoji-library";
import { currentTraceId, markOnce, traced } from "./tracing";
import { observeVisibleMilestone } from "./visible-milestone";
export function TimerSelect({
  value,
  onChange,
  parent = null,
}: {
  value: string;
  onChange: (v: string) => void;
  parent?: string | null;
}) {
  const custom = value === "custom" || value.startsWith("custom:");
  function toLocal(iso: string) {
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  return (
    <div className="timer-control">
      <label className="inline-select">
        <Icon name="clock" size={17} />
        <span className="sr-only">Expiration</span>
        <select
          value={custom ? "custom" : value}
          onChange={(e) => onChange(e.target.value)}
        >
          {parent ? (
            <option value="inherit">Same expiration as parent</option>
          ) : (
            <option value="">No timer</option>
          )}
          {[
            [3600, "1 hour"],
            [86400, "24 hours"],
            [604800, "7 days"],
            [2592000, "30 days"],
          ]
            .filter(
              ([seconds]) =>
                !parent ||
                Date.now() + Number(seconds) * 1000 <
                  new Date(parent).getTime(),
            )
            .map(([seconds, label]) => (
              <option key={seconds} value={seconds}>
                {parent ? "Shorter: " : ""}
                {label}
              </option>
            ))}
          <option value="custom">Choose a time…</option>
        </select>
      </label>
      {custom && (
        <input
          aria-label="Custom expiration date and time"
          className="custom-time"
          type="datetime-local"
          required
          min={toLocal(new Date(Date.now() + 60000).toISOString())}
          max={parent ? toLocal(parent) : undefined}
          value={value.startsWith("custom:") ? toLocal(value.slice(7)) : ""}
          onChange={(e) => {
            if (e.target.value)
              onChange("custom:" + new Date(e.target.value).toISOString());
          }}
        />
      )}
    </div>
  );
}
export function ExpiryWarning({
  expiry,
  reply = false,
  fromPost = false,
}: {
  expiry: string | null;
  reply?: boolean;
  fromPost?: boolean;
}) {
  return expiry ? (
    <div className="timer-warning">
      <Icon name="clock" size={19} />
      <span>
        This {reply ? "reply" : "comment"} will be deleted with the{" "}
        {reply ? "comment" : "post"} on <strong>{localDate(expiry)}</strong> (
        {remaining(expiry)}). You can make its timeout shorter.
        {fromPost && " This deadline is inherited from the original post."}
      </span>
    </div>
  ) : null;
}
function readObjectURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read this photo."));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}
export async function preparePhoto(file: File, maxDimension = 2400) {
  if (file.size > PHOTO_SOURCE_MAX_BYTES)
    throw new Error("Each source photo must be 50 MB or smaller.");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(
      "Your browser could not read this photo. Choose it again. If you selected it from the Mac Photos library, export it from Photos as a JPEG to Downloads, then choose that file. If it is stored in the cloud, download it to this device first.",
    );
  }
  const mime = photoSourceMime(bytes),
    source = mime === "image/jpeg" ? jpegSource(bytes) : null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([(source?.bytes ?? bytes) as BlobPart], { type: mime }),
    );
  } catch {
    throw new Error(
      "This browser could not decode this photo. Export it as a standard JPEG or PNG and try again.",
    );
  }
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement("canvas");
    if (!bitmap.width || !bitmap.height)
      throw new Error("This photo has invalid dimensions.");
    // Native decoding applies EXIF rotation; portrait/landscape may swap axes.
    if (
      source &&
      !(bitmap.width === source.width && bitmap.height === source.height) &&
      !(bitmap.width === source.height && bitmap.height === source.width)
    )
      throw new Error("This photo has inconsistent dimensions.");
    const ratio = Math.min(
      1,
      maxDimension / Math.max(bitmap.width, bitmap.height),
    );
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d", { colorSpace: "srgb" });
    if (!context)
      throw new Error("Image processing is unavailable in this browser.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
  const encoded = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new Error("Could not process this photo.")),
      "image/jpeg",
      0.85,
    ),
  );
  const normalized = stripCanvasJpegMetadata(
    new Uint8Array(await encoded.arrayBuffer()),
  );
  const outputSize = jpegDimensions(normalized);
  if (outputSize.width !== canvas.width || outputSize.height !== canvas.height)
    throw new Error("This photo has inconsistent dimensions.");
  const blob = new Blob([normalized as BlobPart], { type: "image/jpeg" });
  return {
    blob,
    width: canvas.width,
    height: canvas.height,
    preview: await readObjectURL(blob),
  };
}
export type PublishedPost = { row: SocialObject; content: Content };

export function Composer({
  onPosted,
  groupId,
  shareTabs = false,
  initialAlbum,
}: {
  shareTabs?: boolean;
  initialAlbum?: string;
  onPosted: (published?: PublishedPost) => void;
  groupId?: string;
}) {
  const vault = useVault();
  const resolveMentions = useMentionResolver();
  const draft=usePostDraft(vault,shareTabs,{mode:initialAlbum||(shareTabs&&new URLSearchParams(location.search).get("mode")==="photos")?"photos":"post",album:initialAlbum||"",text:"",tags:[],onBehalf:"",audience:groupId?"group":initialAlbum?"only_me":"connections",timer:"",photos:[],videoSources:[]});
  const {mode,album,text,tags,onBehalf,audience,timer,photos,videoSources}=draft.value;
  const setter=<K extends keyof typeof draft.value>(key:K)=>(value:(typeof draft.value)[K]|((old:(typeof draft.value)[K])=>(typeof draft.value)[K]))=>draft.change(key,value);
  const setMode=setter("mode"),setAlbum=setter("album"),setText=setter("text"),setTags=setter("tags"),setOnBehalf=setter("onBehalf"),setAudience=setter("audience"),setTimer=setter("timer"),setPhotos=setter("photos"),setVideoSources=setter("videoSources");
  const [albums,setAlbums]=useState<{id:string;name:string;role:string}[]>([]);
  const [albumsLoaded,setAlbumsLoaded]=useState(false);
  const [photosShared,setPhotosShared]=useState(0);
  const directory=usePeopleDirectory();
  const [importingMedia,setImportingMedia]=useState(false);
  const [largeVideosEnabled,setLargeVideosEnabled]=useState(false);
  const [directVideosEnabled,setDirectVideosEnabled]=useState(false);
  const [pendingVideos,setPendingVideos]=useState<{id:string;createdAt:string}[]>([]);
  const [videoProgress,setVideoProgress]=useState("");
  const uploadAbort=useRef<AbortController|null>(null);
  const preparedVideos=useRef(new Map<string,PreparedLargeVideo>());
  const refreshPendingVideos=async()=>{if(typeof navigator.storage?.getDirectory==="function")setPendingVideos(await pendingPublications(vault.member.id));};
  useEffect(()=>{let alive=true;void get("/videos/capabilities").then(value=>{if(alive){setLargeVideosEnabled(value.enabled===true);setDirectVideosEnabled(value.enabled===true&&value.direct_uploads===true);}}).catch(()=>{});void refreshPendingVideos().catch(()=>{});return()=>{alive=false;uploadAbort.current?.abort();for(const video of preparedVideos.current.values())void video.dispose();};},[vault.member.id]);
  useEffect(()=>{const ids=new Set(photos.map(p=>p.id));for(const[id,video]of preparedVideos.current)if(!ids.has(id)){void video.dispose();preparedVideos.current.delete(id);}},[photos]);
  const draftUrls = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(photos.filter(p => p.preview.startsWith("blob:")).map(p => p.preview));
    for (const url of draftUrls.current) if (!current.has(url)) URL.revokeObjectURL(url);
    draftUrls.current = current;
  }, [photos]);
  useEffect(() => () => { for (const url of draftUrls.current) URL.revokeObjectURL(url); }, []);
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();
  useEffect(()=>{
    if(!shareTabs)return;let alive=true;
    void action.run(async()=>{
      const found=[];let after:string|null=null;
      do{const response:Json=await get("/albums"+(after?"?after="+encodeURIComponent(after):""));
        for(const row of items<any>(response))if(row.role!=="read"){try{const content=await vault.open(row);found.push({id:row.id,name:String(content.name||"Album"),role:row.role});}catch{/* Albums without available keys cannot receive encrypted uploads. */}}
        after=response.next||null;
      }while(after&&alive);
      if(alive){setAlbums(found);setAlbumsLoaded(true);}
    });return()=>{alive=false;};
  },[shareTabs,vault.member.id]);
  async function selectPhotos(files: FileList | File[] | null) {
    if (!files) return;
    const added = await action.run(async () => {
      if (files.length + photos.length > 10)
        throw new Error("You can share up to 10 photos or videos at a time.");
      const next: PendingPhoto[] = [];
      const videos: File[] = [];
      try { for (const file of Array.from(files)) {
        if(largeVideosEnabled&&(mode==="post"||directVideosEnabled)&&(file.type.startsWith("video/")||/\.(mp4|mov|webm)$/i.test(file.name))){videos.push(file);continue;}
        const prepared = file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name)
          ? await prepareVideo(file) : await preparePhoto(file);
        next.push({
          id: crypto.randomUUID(),
          name: file.name,
          alt: "",
          photoDate: await photoCaptureDate(file),
          ...prepared,
        });
      }
      } catch (error) { for (const item of next) if (isVideo(item.mime)) URL.revokeObjectURL(item.preview); throw error; }
      setPhotos(current=>[...current, ...next]);
      setVideoSources(videos);
      return true;
    });
    if (input.current) input.current.value = "";
    return added;
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if(!draft.ready)return;
    if(photos.some(photo=>!photo.photoDate)){await action.run(async()=>{throw Error("Choose a date for each photo or video. Its original date was not available in the selected file.");});return;}
    if(mode==="photos"&&photos.some(p=>p.largeVideo)&&!directVideosEnabled){await action.run(async()=>{throw Error("Direct video uploads are not enabled on this server yet. Please reload and try again.");});return;}
    if(mode==="photos"&&shareTabs){
      if(!photos.length)return;
      const destination=await action.runSave(async()=>{
        if(album&&(!albumsLoaded||!albums.some(a=>a.id===album)))throw Error("Select an album where you have Add or Album-admin permission and working encryption keys.");
        const expiresAt=deadline(timer);setPhotosShared(0);
        for(const original of photos){
          const photo={...original,tags:await resolveMentions(original.alt,original.tags||[])};
          if(photo.largeVideo){const abort=new AbortController();uploadAbort.current=abort;
            try{await stagePhotoVideo(vault,{...photo,photoDate:photo.photoDate||localPhotoDate()},photo.largeVideo,audience,expiresAt,album||null,abort.signal,setVideoProgress);
              setPhotos(current=>current.filter(p=>p.id!==photo.id));await refreshPendingVideos();
              await sendPublication(vault.member.id,photo.id,abort.signal,setVideoProgress);
            }finally{uploadAbort.current=null;setVideoProgress("");await refreshPendingVideos();}
          }else{await publishPhoto(vault,photo,audience,expiresAt,album||null);setPhotos(current=>current.filter(p=>p.id!==photo.id));}
          setPhotosShared(count=>count+1);
        }
        setTimer("");onPosted();
        if(album&&!text.trim())return "/albums/"+album;
      },"Photos and videos shared. Your post draft is preserved.");
      if(destination)navigateAfterSaves(destination);
      return;
    }
    if (!text.trim() && !photos.length) return;
    await action.runSave(async () => {
      const child = onBehalf ? directory.people.find(p => p.kind === "child" && p.id === onBehalf) : null;
      if (onBehalf && !child) throw new Error("Reload the child directory before posting on their behalf.");
      const resolvedTags = await resolveMentions(text,tags);
      const postTags = child && !resolvedTags.some(t => t.kind === "child" && t.id === child.id) ? [...resolvedTags, child] : resolvedTags;
      if (postTags.length > 30) throw new Error("Remove a tag to make room for the child you are posting for.");
      const id = crypto.randomUUID();
      const expiresAt = deadline(timer);
      const createdAt = new Date().toISOString();
      const durable=photos.some(p=>p.largeVideo);
      const abort=new AbortController();uploadAbort.current=abort;
      const staged:Awaited<ReturnType<typeof stageMedia>>[]=[];
      let saved=false;
      const media: MediaPayload[] = [];
      const photoDates=[];
      try {
      for (const photo of photos) {
        const meta = {
          id: crypto.randomUUID(),
          alt: photo.alt,
          tags: await resolveMentions(photo.alt,photo.tags || []),
          mime: photo.mime || "image/jpeg",
          ...(photo.poster ? { poster: photo.poster, posterExpiresAt: expiresAt } : {}),
          name: photo.name,
          width: photo.width,
          height: photo.height,
          ...(photo.largeVideo?{videoVersion:2 as const,duration:photo.largeVideo.duration}:{}),
        };
        const video=photo.largeVideo?await stageVideo(vault.member.id,id,meta.id,photo.largeVideo,abort.signal,fraction=>setVideoProgress(`Encrypting video… ${Math.round(fraction*100)}%`)):undefined;
        const envelope = await vault.seal(
          {
            ...(video?{video,bytes:videoUpdatePlaceholder}:{bytes:bytesToBase64(new Uint8Array(await photo.blob.arrayBuffer()))}),
            ...meta,
          },
          {
            id: meta.id,
            kind: "media",
            audience,
            parentId: id,
            groupId: groupId || null,
            createdAt,
            expiresAt,
          },
        );
        const bytes = new TextEncoder().encode(JSON.stringify(envelope));
        if (bytes.length > 22_020_096) throw Error("This encrypted attachment is too large for this audience. Choose a smaller file.");
        if(durable)staged.push(await stageMedia(vault.member.id,id,envelope,video));
        else {const upload = await post("/media", {
          id: meta.id,
          envelope,
          byte_size: bytes.length,
        });
        await request(upload.upload_url, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Blob([bytes]),
        });}
        media.push(meta);
        photoDates.push(await signAttachmentDate(vault,meta.id,id,photo.photoDate||localPhotoDate(),1));
      }
      const publishedContent = { text: text.trim(), tags:postTags, media, reactionSecret: createReactionSecret() };
      const envelope = await vault.seal(
        publishedContent,
        {
          id,
          kind: "post",
          audience,
          groupId: groupId || null,
          createdAt,
          expiresAt,
        },
      );
      const notification_preview=await prepareNotificationPreview(vault,[envelope],"post",id,text.trim()||photos[0]?.alt||"",photos[0]);
      const publication={envelope,photo_dates:photoDates,media_ids:media.map(p=>p.id),on_behalf_of:onBehalf||null,...(notification_preview?{notification_preview}:{})};
      await draft.beforePublish(id,durable);
      if(durable){await savePublication(vault.member.id,id,staged,publication);saved=true;
        // The durable encrypted post now owns this intent. Remove the live draft
        // before sending so an uncertain response cannot create a duplicate post.
        await draft.clear().catch(()=>{});
        setText("");setTags([]);setOnBehalf("");setPhotos([]);setTimer("");
        await refreshPendingVideos();await sendPublication(vault.member.id,id,abort.signal,setVideoProgress);
      }else await post("/posts",publication);
      if(shareTabs)await draft.clear().catch(()=>{});
      setText("");
      setTags([]);setOnBehalf("");
      setPhotos([]);
      setTimer("");
      onPosted({row:{id,author_id:vault.member.id,author_device_id:vault.device.id,author_handle:vault.member.handle,envelope,created_at:createdAt,expires_at:expiresAt,audience,group_id:groupId||null,on_behalf_of:onBehalf||null,media_ids:media.map(p=>p.id)},content:publishedContent});
      }finally{if(durable&&!saved)await discardLocalPublication(vault.member.id,id);uploadAbort.current=null;setVideoProgress("");if(durable)await refreshPendingVideos();}
    }, shareTabs ? undefined : "Post shared.");
  }
  if (vault.member.status === "restricted") return null;
  return (
    <form
      className="composer panel"
      data-unsaved-draft={(Boolean(text.trim() || photos.length || videoSources.length || importingMedia)&&(!shareTabs||draft.unsaved||!draft.ready||importingMedia)) || undefined}
      data-draft-saved={shareTabs&&draft.ready&&!draft.unsaved&&!importingMedia?"true":undefined}
      onSubmit={submit}
    >

      {pendingVideos.map(p=><div className="panel" key={p.id}><p>An encrypted upload is saved on this device ({localDate(p.createdAt)}).</p><Button type="button" disabled={action.busy} onClick={()=>void action.runSave(async()=>{const abort=new AbortController();uploadAbort.current=abort;try{await sendPublication(vault.member.id,p.id,abort.signal,setVideoProgress);onPosted();}finally{uploadAbort.current=null;setVideoProgress("");await refreshPendingVideos();}},"Upload shared.")}>Resume upload</Button><Button type="button" disabled={action.busy} onClick={()=>void action.run(async()=>{await cancelPublication(vault.member.id,p.id);await refreshPendingVideos();})}>Cancel upload</Button></div>)}
      {videoProgress&&<div role="status"><p>{videoProgress}</p><Button type="button" onClick={()=>uploadAbort.current?.abort()}>Pause upload</Button></div>}
      <fieldset disabled={action.busy||importingMedia||!draft.ready} className="composer-fields">
      {shareTabs&&<div className="tabs" aria-label="What to share"><button type="button" disabled={action.busy} className={mode==="post"?"active":""} aria-pressed={mode==="post"} onClick={()=>setMode("post")}>Post</button><button type="button" disabled={action.busy} className={mode==="photos"?"active":""} aria-pressed={mode==="photos"} onClick={()=>setMode("photos")}>Photos & videos</button></div>}
      {mode==="post"&&<>
      <div className="composer-start">
        <MemberAvatar memberId={vault.member.id} name={vault.member.handle} />
        <label className="sr-only" htmlFor="post-text">
          Write a post
        </label>
        <textarea data-diagnostic-input="social-text"
          id="post-text"
          rows={3}
          maxLength={5000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a post…"
        />
      </div>
      <TagPicker text={text} value={tags} onChange={setTags} disabled={action.busy}/>
      <p className="muted">Tags do not change who can see this post.</p>
      {<label>Posting on behalf of <select aria-label="Posting on behalf of" onFocus={directory.ensure} value={onBehalf} onChange={e=>{setOnBehalf(e.target.value);const child=directory.people.find(p=>p.kind==="child"&&p.id===e.target.value);if(child&&!tags.some(t=>t.id===child.id))setTags([...tags,child]);}}><option value="">Myself</option>{directory.children.filter(c=>c.can_post).map(c=><option key={c.id} value={c.id}>{c.name} · posted by @{vault.member.handle}</option>)}</select></label>}
      {onBehalf && <p className="muted">The child will be tagged automatically. You remain the author.</p>}
      </>}
      {mode==="post"?<><hr className="composer-photo-divider"/><h2 className="composer-photo-heading">Add Photos/Videos to this Post</h2>{shareTabs&&<p className="composer-photo-shortcut">(Skip the post and <a href="/share?mode=photos" aria-disabled={action.busy} onClick={event=>{event.preventDefault();if(!action.busy)setMode("photos");}}>add photos/videos directly</a>.)</p>}</>:<>
        <h2 className="composer-photo-heading">Add photos/videos</h2>
        <p>Each photo or video has its own date, caption and audience. No post is created.</p>
        <label>Album<select value={album} disabled={action.busy||!albumsLoaded} onChange={e=>setAlbum(e.target.value)}><option value="">No album</option>{initialAlbum&&!albums.some(a=>a.id===initialAlbum)&&<option value={initialAlbum}>Selected album (checking access…)</option>}{albums.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        {album&&<p>Everyone in {albums.find(a=>a.id===album)?.name||"this album"} can view these photos, in addition to the audience selected below. Future album members may receive album history.</p>}
        {text.trim()&&<p className="muted">Your post text is saved in the Post tab for this visit.</p>}
      </>}
      {photos.length > 0 && (
        <div className="photo-editor">
          {photos.map((photo,index) => (
            <div className="photo-draft" key={photo.id}>
              {isVideo(photo.mime) ? <video src={photo.preview} controls playsInline preload="metadata" aria-label="Video preview" /> : <img src={photo.preview} alt="Photo preview" />}
              <Field type="date" min="0001-01-01" max="9999-12-31" label="Photo/video date" required value={photo.photoDate??""} disabled={action.busy} onChange={e=>setPhotos(current=>current.map(p=>p.id===photo.id?{...p,photoDate:e.target.value}:p))}/>
              {!photo.photoDate&&<p className="muted">The original date wasn’t included in this file. Please choose its date.</p>}
              <Field
                label="Photo or video description"
                value={photo.alt}
                onChange={(e) =>
                  setPhotos(
                    photos.map((p) =>
                      p.id === photo.id ? { ...p, alt: e.target.value } : p,
                    ),
                  )
                }
                maxLength={1000}
                data-diagnostic-input="media-caption"
                placeholder="Describe this photo or video for everyone"
              />
              <TagPicker text={photo.alt} label="People in this photo or video" value={photo.tags||[]} disabled={action.busy} onChange={tags=>setPhotos(photos.map(p=>p.id===photo.id?{...p,tags}:p))}/>
              {photos.length>1&&<div className="album-actions"><Button variant="quiet" disabled={index===0} aria-label={`Move ${photo.name} earlier`} onClick={()=>setPhotos(current=>{const next=[...current];[next[index-1],next[index]]=[next[index],next[index-1]];return next;})}>Move earlier</Button><Button variant="quiet" disabled={index===photos.length-1} aria-label={`Move ${photo.name} later`} onClick={()=>setPhotos(current=>{const next=[...current];[next[index],next[index+1]]=[next[index+1],next[index]];return next;})}>Move later</Button></div>}
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove ${photo.name}`}
                onClick={() =>
                  setPhotos(photos.filter((p) => p.id !== photo.id))
                }
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
      {mode==="photos"&&photosShared>0&&<p role="status">{photosShared} item{photosShared===1?"":"s"} shared.{photos.length>0?" Remaining photos and videos are still selected.":""}</p>}
      <Alert>{action.error}</Alert>
      <Alert success>{action.notice}</Alert>
      {shareTabs&&<SharedMediaInbox disabled={action.busy||videoSources.length>0} remaining={10-photos.length} onImport={selectPhotos} onBusy={setImportingMedia}/>}
      <div className={"composer-controls"+(mode==="post"?" composer-post-controls":"")}>
        <div className="composer-tools">
          <input
            ref={input}
            type="file"
            disabled={action.busy||videoSources.length>0||photos.length>=10}
            accept="image/*,video/*"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => selectPhotos(e.target.files)}
          />
          <button
            type="button"
            className="text-button composer-add-media"
            aria-label="Add photos/videos"
            disabled={action.busy||videoSources.length>0||photos.length>=10}
            onClick={() => input.current?.click()}
          >
            <Icon name="photo" size={18} />
            <span>Add photos/videos</span>
          </button>
          {videoSources[0]&&<VideoPicker key={videoSources[0].name+videoSources.length} file={videoSources[0]} onDone={()=>setVideoSources(current=>current.slice(1))} onPrepared={(video,name,captureDate)=>{const id=crypto.randomUUID();preparedVideos.current.set(id,video);setPhotos(current=>[...current,{id,name,alt:"",photoDate:captureDate,blob:video.blob,width:video.width,height:video.height,mime:video.mime,poster:video.poster,preview:video.preview,largeVideo:video}]);}}/>}
        </div>

      </div>
      <details className="composer-media-info"><summary>Video limits & storage</summary>
      <p className="muted">{largeVideosEnabled?"Videos: choose a full recording up to 10 minutes and a 1 GiB source. Prepare at 1080p or 720p, up to 250 MiB. Photos and videos share your 10 GB media allowance.":"Videos: MP4, MOV or WebM, up to 10 MiB and 4K. Playback depends on the viewer’s browser. Original video metadata is shared with your selected audience."}</p>
      </details>
      <div className="composer-privacy">
        <Icon name="lock" size={13} />
        {groupId ? (
          <span>Encrypted for this group</span>
        ) : (
          <label>
            Share with{" "}
            <select
              aria-label="Post audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value as Audience)}
            >
              <option value="connections">Friends & family</option>
              <option value="friends">Friends</option>
              <option value="family">Family</option>
              <option value="extended_family">Extended family</option>
              <option value="community">Community</option>
              <option value="only_me">Only me</option>
            </select>
          </label>
        )}
        {(audience==="community"||audience==="extended_family")&&<span>People in your current circle can see its shared history. Direct connection history choices do not change circle access.</span>}
        {audience === "friends" && <span>Excludes family connections</span>}
        {timer && <span>· disappears {localDate(deadline(timer)!)}</span>}
        {mode==="post"&&<span className="character-count">{text.length}/5,000</span>}
      </div>
      </fieldset>
      <footer className="composer-footer">
        {shareTabs&&<><Alert>{draft.error}</Alert>{draft.error&&!draft.ready&&<Button type="button" onClick={draft.retryRestore}>Try restoring draft again</Button>}{draft.error&&draft.ready&&<Button type="button" onClick={draft.retry}>Retry saving draft</Button>}</>}
        <div className="composer-actions">
          <fieldset className="composer-fields" disabled={action.busy||importingMedia||!draft.ready}>
            <TimerSelect value={timer} onChange={setTimer} />
          </fieldset>
        <Button
          variant="primary"
          type="submit"
          busy={action.busy}
          disabled={importingMedia||!draft.ready||videoSources.length>0||(mode==="photos"?!photos.length:!text.trim()&&!photos.length)}
        >
          {mode==="photos"?(album?"Add to album":"Share photos & videos"):"Share post"} <Icon name="arrow" size={16} />
        </Button>
          {shareTabs&&(text||photos.length||videoSources.length||draft.error)&&<Button type="button" variant="outline compact composer-discard" disabled={action.busy||importingMedia} onClick={()=>{if(window.confirm("Discard this draft and its selected photos/videos?"))void action.run(()=>draft.discard());}}>Discard draft</Button>}
          {shareTabs&&<span className="draft-status small-copy" role="status">{!draft.ready&&!draft.error?"Restoring draft…":draft.status}</span>}
        </div>
      </footer>
    </form>
  );
}
export function Feed({
  wallId,
  groupId,
  singleId,
  canModerate = false,
  authorFilter, contentFilter = "posts", infinite = false,
}: {
  authorFilter?: AuthorFilter; contentFilter?: FeedContent; infinite?: boolean;
  wallId?: string;
  groupId?: string;
  singleId?: string;
  canModerate?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);
  const [rows, setRows] = useState<SocialObject[]>([]);
  const [singleDetails, setSingleDetails] = useState<Json | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [version, setVersion] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const loadVersion = useRef(0);
  const action = useAction();
  useEffect(() => {
    if (loaded) markOnce("feed-loaded");
  }, [loaded]);
  const endpoint = singleId
    ? `/posts/${singleId}`
    : groupId
      ? `/groups/${groupId}/posts`
      : wallId
        ? `/walls/${wallId}`
        : "/feed";
  async function load(more = false) {
    const attempt = ++loadVersion.current;
    await action.run(async () => {
      let r: Json;
      try {
        r = await get(
          `${endpoint}${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
      } catch (e) {
        if (attempt === loadVersion.current && accessLost(e)) {
          setRows([]);
          setSingleDetails(null);
          setCursor(null);
          setLoaded(true);
        }
        throw e;
      }
      if (attempt !== loadVersion.current) return;
      const next = singleId ? [r.post] : items<SocialObject>(r);
      setSingleDetails(singleId ? r : null);
      setRows((old) =>
        more
          ? [...old, ...next.filter((n) => !old.some((o) => o.id === n.id))]
          : next,
      );
      setCursor(r.next_cursor || null);
      setLoaded(true);
    });
  }
  useEffect(() => {
    load();
    return () => {
      loadVersion.current++;
    };
  }, [endpoint, version]);
  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1000);
    const visible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    window.addEventListener("porchday:posts-shared", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("porchday:posts-shared", visible);
    };
  }, [endpoint]);
  useEffect(() => {
    if (!infinite || !cursor || action.busy || action.error || !sentinel.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting) || loadingMore.current) return;
      loadingMore.current = true;
      observer.disconnect();
      void load(true).finally(() => { loadingMore.current = false; });
    }, {rootMargin: `${Math.ceil(innerHeight*6)}px`});
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [infinite, cursor, action.busy, action.error]);
  const refresh = () => setVersion((v) => v + 1);
  return (
    <>
      {groupId && !wallId && !singleId && (
        <Composer onPosted={refresh} groupId={groupId} />
      )}
      <div className="feed-heading">
        <span>
          {groupId
            ? "Group posts"
            : singleId
              ? "Post"
              : "Posts"}
        </span>
        <button className="text-button" onClick={() => load()}>
          <Icon name="clock" size={14} />
          Newest first
        </button>
      </div>
      <Alert>{action.error}</Alert>
      {!loaded && action.busy ? (
        <Loading />
      ) : (
        rows
          .filter(unexpired)
          .filter(row => !authorFilter || matchesAuthor(row, authorFilter))
          .map((row) => (
            <PostCard
              key={row.id + ":" + row.envelope.context.revision}
              row={row}
              contentFilter={contentFilter}
              onChange={refresh}
              expanded={!!singleId}
              initialDetails={singleId ? singleDetails : null}
              canModerate={canModerate}
            />
          ))
      )}
      {loaded && !rows.filter(unexpired).length && (
        <div className="panel">
          <Empty
            icon=""
            title={
              singleId
                ? "Post unavailable"
                : "No posts yet"
            }
            action={
              !groupId && !singleId ? (
                <a className="button outline compact" href="/connections">
                  Find a friend <Icon name="arrow" size={16} />
                </a>
              ) : undefined
            }
          >
            {singleId
              ? "It may have expired, been removed, or no longer be shared with you."
              : "Posts from your connections appear here in chronological order."}
          </Empty>
        </div>
      )}
      {cursor && <div ref={sentinel} aria-hidden="true" />}
      {cursor && (
        <Button
          variant="outline full"
          busy={action.busy}
          onClick={() => load(true)}
        >
          Load more posts
        </Button>
      )}
      {loaded && rows.length > 0 && !cursor && (
        <div className="caught-up">
          <Icon name="check" size={20} />
          <p>
            No more posts.
          </p>
        </div>
      )}
    </>
  );
}
export function PostCard({
  row,
  initialDetails,
  initialContent,
  onChange,
  expanded = false,
  canModerate = false,
  contentFilter = "posts",
}: {
  contentFilter?: FeedContent;
  row: SocialObject;
  initialDetails?: Json | null;
  initialContent?: Content;
  onChange: () => void;
  expanded?: boolean;
  canModerate?: boolean;
}) {
  const vault = useVault();
  const resolveMentions = useMentionResolver();
  const [content, setContent] = useState<Content | null>(initialContent ?? null);
  const readableRef = useRef<HTMLParagraphElement>(null);
  const [error, setError] = useState("");
  const [showComments, setShowComments] = useState(expanded);
  const [showReport, setShowReport] = useState(false);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const [reshare, setReshare] = useState(false);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(false);
  const [editText, setEditText] = useState("");
  const [editTags,setEditTags]=useState<PersonTag[]>([]);
  const [editMedia,setEditMedia]=useState<MediaPayload[]>([]);
  const [editTimer, setEditTimer] = useState("inherit");
  const { ref: cardRef, near: cardNear } = useNearViewport<HTMLElement>(true,6);
  // Reuse only the matching response that already authorized this post view.
  const seed = initialDetails?.post?.id === row.id &&
    initialDetails.post.envelope?.ciphertext === row.envelope.ciphertext ? initialDetails : null;
  const detailScope = vault.member.id + ":" + vault.device.id + ":" + row.id + ":" + row.envelope.ciphertext;
  const [detailState, setDetailState] = useState<{ scope: string; value: Json | null }>(() => ({ scope: detailScope, value: seed }));
  const details = detailState.scope === detailScope ? detailState.value : null;
  const detailRequest = useRef<{ scope: string; generation: number; pending: Promise<void> | null }>({ scope: detailScope, generation: 0, pending: null });
  if (detailRequest.current.scope !== detailScope)
    detailRequest.current = { scope: detailScope, generation: 0, pending: null };
  const initialDetailsId = useRef("");
  const [unavailable, setUnavailable] = useState(false);
  const action = useAction();
  const deletingId = useRef<string | null>(null);
  const [deletion, setDeletion] = useState<{ id: string; status: "deleting" | "deleted" | "failed"; error?: string } | null>(null);
  const currentDeletion = deletion?.id === row.id ? deletion : null;
  useEffect(() => {
    let alive = true;
    vault
      .open(row)
      .then((c) => {
        if (alive) {
          setContent(c);
          setEditText(String(c.text || ""));setEditTags(validTags(c.tags));setEditMedia(c.media||[]);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [row.id, row.envelope.ciphertext]);
  function loadDetails(fresh = true): Promise<void> {
    const state = detailRequest.current;
    // A completed mutation from an earlier render must not refresh a new post.
    if (state.scope !== detailScope) return Promise.resolve();
    // Initial visibility and opening comments may share a pending read. A read
    // after a mutation must start after that mutation, never reuse an older one.
    if (!fresh && state.pending) return state.pending;
    const generation = ++state.generation;
    const current = () => detailRequest.current === state && state.generation === generation;
    const pending = (async () => {
      try {
        const d = await get(`/posts/${row.id}`);
        if (current()) setDetailState({ scope: detailScope, value: d });
      } catch (e) {
        if (!current()) return;
        if (accessLost(e)) {
          setUnavailable(true);
          setContent(null);
          setDetailState({ scope: detailScope, value: null });
        }
        throw e;
      } finally {
        if (current()) state.pending = null;
      }
    })();
    state.pending = pending;
    return pending;
  }
  useEffect(() => {
    const state = detailRequest.current;
    if (seed) {
      initialDetailsId.current = detailScope;
      setDetailState({ scope: detailScope, value: seed });
    }
    return () => { state.generation++; state.pending = null; };
  }, [detailScope, seed]);
  useEffect(() => {
    if ((cardNear || expanded) && initialDetailsId.current !== detailScope) {
      initialDetailsId.current = detailScope;
      loadDetails(false).catch(() => {});
    }
  }, [detailScope, cardNear, expanded]);
  const expiry = row.effective_expires_at || row.expires_at;
  useEffect(() => {
    const element = readableRef.current;
    if (!currentTraceId() || !element || !content || error || unavailable || edit || !content.text) return;
    return observeVisibleMilestone(element,
      () => !expiry || Date.parse(expiry) > Date.now(),
      () => markOnce("first-readable-post"));
  }, [content, error, unavailable, edit, expiry]);
  const own = row.author_id === vault.member.id;
  async function remove() {
    if (action.busy || deletingId.current === row.id || currentDeletion?.status === "deleted") return;
    if (!confirm("Delete this post and its comments, reactions, and attachments? Photos added to albums remain available separately. Use Delete photo in Feed → Photos to remove those everywhere.")) return;
    const id = row.id;
    deletingId.current = id;
    setMenu(false);
    setDeletion({ id, status: "deleting" });
    try {
      await del(`/posts/${id}`);
    } catch (error) {
      setDeletion({ id, status: "failed", error: "Deletion was not confirmed. You can try again. " + message(error) });
      return;
    } finally {
      if (deletingId.current === id) deletingId.current = null;
    }
    // Hide the content immediately on confirmation, independently of a slow or
    // failed parent refresh. Never report a refresh failure as a failed delete.
    setDeletion({ id, status: "deleted" });
    try { await onChange(); }
    catch (error) { setDeletion({ id, status: "deleted", error: "Post deleted, but this view could not refresh. " + message(error) }); }
  }
  async function saveEdit() {
    await action.runSave(async () => {
      const previous = content;
      const resolvedTags=await resolveMentions(editText,editTags);
      const resolvedMedia=await Promise.all(editMedia.map(async media=>({...media,tags:await resolveMentions(media.alt,media.tags||[])})));
      setContent({ ...content, text: editText, tags:resolvedTags,media:resolvedMedia });
      setEdit(false);
      try {
        const envelope = await vault.seal(
          { ...content, text: editText, tags:resolvedTags,media:resolvedMedia },
          {
            ...row.envelope.context,
            authorDeviceId: vault.device.id,
            expiresAt: deadline(editTimer, row.expires_at),
            revision: row.envelope.context.revision + 1,
          },
          row.id,
        );
        const lifecycle = await signStatement(
          {
            purpose: "porchday-lifecycle",
            id: row.id,
            revision: envelope.context.revision,
            expiresAt: envelope.context.expiresAt,
          },
          vault.privateKey,
        );
        await request(`/posts/${row.id}`, {
          method: "PUT",
          body: JSON.stringify({ envelope, lifecycle }),
        });
      } catch (error) {
        setContent(previous);
        setEdit(true);
        throw new Error("Save was not confirmed. Your draft is restored; the preview was rolled back. " + message(error));
      }
      onChange();
    });
  }
  if (currentDeletion?.status === "deleting" || currentDeletion?.status === "deleted")
    return <article className="post-card panel" data-deletion-state={currentDeletion.status}>
      {currentDeletion.status === "deleting" ? <Loading text="Deleting post…" /> : <div role="status">Post deleted.</div>}
      <Alert>{currentDeletion.error}</Alert>
    </article>;
  if (content && !matchesContent(content, contentFilter)) return null;
  if (unavailable)
    return (
      <div className="panel">
        <Alert>This post is no longer available.</Alert>
      </div>
    );
  return (
    <article ref={cardRef} data-feed-readable={content ? "true" : "false"} className="post-card panel">
      <Alert>{currentDeletion?.error}</Alert>
      <header className="post-heading">
        <ActivityAuthor memberId={row.author_id} handle={row.author_handle} date={row.created_at} sharing={postAudienceLabel(row.audience,row.group_id)}/>
        <div className="post-menu">
          <button
            ref={optionsButton}
            className="icon-button"
            disabled={action.busy}
            onClick={() => setMenu(!menu)}
            aria-label="Post options"
            aria-expanded={menu}
          >
            <Icon name="more" />
          </button>
          {menu && (
            <div className="dropdown-menu">
              {own && vault.member.status !== "restricted" && (
                <>
                  <button
                    onClick={() => {
                      setEditTags(validTags(content?.tags));setEditMedia(content?.media||[]);
                      setEditText(String(content?.text||""));
                      setEdit(true);
                      setMenu(false);
                    }}
                  >
                    <Icon name="edit" size={16} />
                    Edit text
                  </button>
                  {content && (
                    <button
                      onClick={() => {
                        setReshare(true);
                        setMenu(false);
                      }}
                    >
                      <Icon name="arrow" size={16} />
                      Share as a new post
                    </button>
                  )}
                </>
              )}
              {(own || canModerate) && vault.member.status !== "restricted" && (
                <button onClick={remove}>
                  <Icon name="trash" size={16} />
                  {own ? "Delete post" : "Remove group post"}
                </button>
              )}
              <button
                onClick={() => {
                  setShowReport(true);
                  setMenu(false);
                }}
              >
                <Icon name="shield" size={16} />
                Report a concern
              </button>
              <a href={`/post/${row.id}`}>
                <Icon name="external" size={16} />
                Open post
              </a>
            </div>
          )}
        </div>
      </header>
      {expiry && (
        <div className="expiry-chip">
          <Icon name="clock" size={13} />
          Disappears {localDate(expiry)}
          <span>· {remaining(expiry)}</span>
        </div>
      )}
      {error ? (
        <div className="encrypted-unavailable">
          <Icon name="lock" />
          <p>{error}</p>
        </div>
      ) : !content ? (
        <Loading text="Loading post…" />
      ) : edit ? (
        <div className="form-stack">
          <label className="field">
            <span>Edit your post</span>
            <textarea data-diagnostic-input="social-text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={5000}
              rows={5}
            />
          </label>
          <TagPicker text={editText} value={editTags} onChange={setEditTags} disabled={action.busy}/>
          {editMedia.map(media=><div key={media.id} className="photo-draft">
            <EncryptedPhoto media={media}/>
            <AttachmentDateEditor mediaId={media.id} postId={row.id} createdAt={row.created_at}/>
            <Field label={isVideo(media.mime) ? "Video caption" : "Photo caption"} value={media.alt} maxLength={1000} onChange={e=>setEditMedia(old=>old.map(m=>m.id===media.id?{...m,alt:e.target.value}:m))}/>
            <TagPicker text={media.alt} label="People in this photo or video" value={media.tags||[]} disabled={action.busy} onChange={tags=>setEditMedia(old=>old.map(m=>m.id===media.id?{...m,tags}:m))}/>
          </div>)}
          <TimerSelect
            value={editTimer}
            onChange={setEditTimer}
            parent={row.expires_at}
          />
          <p className="small-copy">
            You can add or shorten a timer. Existing deadlines cannot be
            extended or removed.
          </p>
          <div className="button-row">
            <Button
              variant="primary compact"
              busy={action.busy}
              onClick={saveEdit}
            >
              Save changes
            </Button>
            <Button variant="quiet compact" onClick={() => setEdit(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ReshareProvenance content={content} />
          <p ref={readableRef} className="post-text"><PostText text={String(content.text || "")} tags={content.tags}/></p>
          <Tags value={content.tags}/>
          {row.on_behalf_of && <p className="muted">Posted on behalf of {validTags(content.tags).find(t=>t.kind==="child"&&t.id===row.on_behalf_of)?.label||"a child"} by @{row.author_handle||"the author"}.</p>}
          {content.media && (
            <div
              className={`post-photos photos-${Math.min(content.media.length, 3)}`}
            >
              {content.media.map((media) => (
                <EncryptedPhoto key={media.id} media={media} />
              ))}
            </div>
          )}
        </>
      )}
      <Alert>{action.error}</Alert>
      <div className="post-actions">
        <Reactions
          target={row}
          payload={content}
          reactions={details?.reactions || []}
          reload={loadDetails}
        />
        <button
          className="text-button comment-toggle"
          onClick={() => {
            setShowComments(!showComments);
            if (!showComments) void action.run(() => loadDetails(false));
          }}
        >
          <Icon name="comment" size={18} />
          {details?.comments?.length || row.comment_count || ""}{" "}
          <span>Comment</span>
        </button>
      </div>
      {showComments && (
        <Comments
          postRow={row}
          details={details}
          onChange={loadDetails}
          canModerate={canModerate}
        />
      )}{" "}
      {showReport && (
        <ReportDialog
          row={row}
          content={content}
          returnFocusRef={optionsButton}
          onClose={() => setShowReport(false)}
        />
      )}{" "}
      {reshare && content && (
        <ReshareDialog
          source={row}
          content={content}
          onClose={() => setReshare(false)}
          onShared={() => {
            setReshare(false);
            onChange();
          }}
        />
      )}
    </article>
  );
}
export function EncryptedPhoto(props:{media:MediaPayload;thumbnail?:boolean;photoProof?:PhotoProof}){return (props.media.videoVersion===2||props.media.videoVersion===3)?<SegmentedVideo media={props.media} thumbnail={props.thumbnail} photoProof={props.photoProof}/>:props.media.mime==="image/jpeg"?<CachedEncryptedPhoto {...props}/>:<LegacyEncryptedPhoto {...props}/>;}
function LegacyEncryptedPhoto({ media, thumbnail=false, photoProof }: { media: MediaPayload; thumbnail?:boolean; photoProof?:PhotoProof }) {
  const vault = useVault();
  const { ref: photoRef, near } = useNearViewport<HTMLDivElement>();
  const imageRef = useRef<HTMLImageElement>(null);
  const [viewer,setViewer]=useState(false);
  useEffect(()=>setViewer(false),[media.id]);
  const video = isVideo(media.mime);
  const [requested, setRequested] = useState<string | null>(null);
  const [poster, setPoster] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    let alive = true, url = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPoster(null);
    const deadline = media.posterExpiresAt === null ? Infinity : Date.parse(media.posterExpiresAt || "");
    if (near && video && deadline > Date.now() && typeof media.poster === "string" && media.poster.length <= 100000) {
      void Promise.resolve().then(() => validatedPhoto(base64ToBytes(media.poster!))).then(({ blob }) => {
        if (alive && deadline > Date.now()) {
          url = URL.createObjectURL(blob); setPoster({ id: media.id, url });
          const expire = () => {
            if (deadline <= Date.now()) { URL.revokeObjectURL(url); url = ""; setPoster(null); }
            else if (Number.isFinite(deadline)) timer = setTimeout(expire, Math.min(deadline - Date.now(), 2147483647));
          };
          expire();
        }
      }).catch(() => {});
    }
    return () => { alive = false; if (timer) clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [media.id, media.poster, media.posterExpiresAt, near, video]);
  const [opened, setOpened] = useState<{ id: string; url: string; expiresAt: number | null } | null>(
    null,
  );
  const [error, setError] = useState("");
  const url = opened?.id === media.id ? opened.url : "";
  useEffect(() => {
    if (!near || (video && (thumbnail || requested !== media.id))) return;
    let alive = true;
    let objectUrl = "";
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setOpened(null);
    setError("");
    fetch(`/api/v1/media/${media.id}/bytes`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("This attachment is no longer available.");
        const envelope = (await response.json()) as EncryptedEnvelope;
        const payload = await vault.open({ envelope, id: media.id });
        if (payload.mime !== media.mime || typeof payload.bytes !== "string")
          throw new Error("Unsupported media format.");
        const bytes = base64ToBytes(payload.bytes);
        if(photoProof)await verifyPhotoBytes(photoProof,bytes);
        const { blob } = await traced("media decode", () => validatedMedia(bytes, media.mime), { bytes: bytes.length,...causeOf(payload) });
        if (!alive) return;
        const expiry = envelope.context.expiresAt
          ? Date.parse(envelope.context.expiresAt)
          : null;
        if (expiry !== null && expiry <= Date.now())
          throw new Error("This attachment expired.");
        objectUrl = URL.createObjectURL(blob);
        markOnce("photo-decoded");
        setOpened({ id: media.id, url: objectUrl, expiresAt: expiry });
        const checkExpiry = () => {
          if (expiry === null || !alive) return;
          const remaining = expiry - Date.now();
          if (remaining <= 0) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = "";
            setOpened(null);
            setError("This attachment expired.");
          } else
            expiryTimer = setTimeout(
              checkExpiry,
              Math.min(remaining, 2_147_483_647),
            );
        };
        checkExpiry();
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      controller.abort();
      if (expiryTimer) clearTimeout(expiryTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media.id, media.mime, near, requested, thumbnail, video, photoProof]);
  useEffect(() => {
    const element = imageRef.current;
    if (!currentTraceId() || !element || !url || !opened) return;
    return observeVisibleMilestone(element,
      () => element.getAttribute("src") === url && (opened.expiresAt === null || opened.expiresAt > Date.now()),
      () => markOnce("first-visible-photo"));
  }, [url, opened]);
  return <div ref={photoRef} className={thumbnail ? "calendar-thumbnail" : undefined}>{url ? (
    <figure>
      {video ? <video src={url} controls playsInline preload="metadata" aria-label={media.alt || "Shared video"} width={media.width} height={media.height} /> : <img
        ref={imageRef}
        src={url}
        alt={media.alt || "Shared photo (no description provided)"}
        loading="lazy"
        decoding="async"
        width={media.width}
        height={media.height}
        role={thumbnail?undefined:"button"}
        tabIndex={thumbnail?undefined:0}
        aria-label={thumbnail?undefined:`Open photo: ${media.alt||"Shared photo"}`}
        onClick={thumbnail?undefined:()=>setViewer(true)}
        onKeyDown={thumbnail?undefined:e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setViewer(true);}}}
        className={thumbnail?undefined:"viewable-photo"}
      />}
      {!thumbnail&&!video&&viewer&&<PhotoViewer src={url} alt={media.alt||""} onClose={()=>setViewer(false)}/>}
      {!thumbnail && media.alt && <figcaption><PostText text={media.alt} tags={media.tags}/></figcaption>}
      {!thumbnail && <Tags value={media.tags}/>}
    </figure>
  ) : video && requested !== media.id ? (
    <figure>
      {poster?.id === media.id && <img src={poster.url} alt={media.alt || "Video preview"} />}
      {thumbnail ? <span className="calendar-video-indicator" aria-label="Video">▶</span> : <Button onClick={() => setRequested(media.id)}>Load video</Button>}
      {!thumbnail && media.alt && <figcaption><PostText text={media.alt} tags={media.tags}/></figcaption>}
      {!thumbnail && <Tags value={media.tags} />}
    </figure>
  ) : (
    <div className="photo-placeholder">
      <Icon name={error ? "shield" : "photo"} size={24} />
      <span>{error || (near ? "Opening encrypted media…" : "Media loads as you scroll")}</span>
    </div>
  )}</div>;
}
export function Reactions({
  target,
  payload,
  reactions,
  reload,
}: {
  target: SocialObject;
  payload: Content | null;
  reactions: Json[];
  reload: () => Promise<void>;
}) {
  const vault = useVault(),
    owner = vault.member.id + ":" + vault.device.id;
  const identity = owner + ":" + target.id + ":" + target.envelope.ciphertext;
  const current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true),
    changing = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const pendingStatus = useRef<HTMLSpanElement>(null);
  const restoreReactionFocus = useRef(false);
  const [picker, setPicker] = useState(false),
    [suggested, setSuggested] = useState<CustomEmoji | null>(null);
  const [opened, setOpened] = useState<{
    identity: string;
    entries: DecodedReaction[];
  }>({ identity, entries: [] });
  const confirmed = opened.identity === identity ? opened.entries : [];
  type PendingReaction = { identity: string; value: ReactionPayload; removing: boolean; tag: string;
    send?: () => Promise<unknown>; uncertain: boolean };
  const [pending, setPending] = useState<PendingReaction | null>(null);
  const pendingRef = useRef<PendingReaction | null>(null);
  const decodeGeneration = useRef(0);
  const activePending = pending?.identity === identity ? pending : null;
  const decoded = typeof payload?.reactionSecret !== "string" ? [] : activePending
    ? [...confirmed.filter(entry => !(entry.memberId === vault.member.id && entry.payload.emoji === activePending.value.emoji)),
       ...(activePending.removing ? [] : [{memberId: vault.member.id, tag: activePending.tag, payload: activePending.value}])]
    : confirmed;
  const action = useAction();
  useEffect(() => {
    if (!restoreReactionFocus.current) return;
    if (activePending) pendingStatus.current?.focus();
    else if (!action.busy) { addButton.current?.focus(); restoreReactionFocus.current = false; }
  }, [activePending, action.busy]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const secret = payload?.reactionSecret;
    if (pendingRef.current?.identity !== identity) { pendingRef.current = null; setPending(null); }
    const generation = ++decodeGeneration.current;
    if (typeof secret !== "string") { setOpened({identity, entries: []}); pendingRef.current = null; setPending(null); }
    if (typeof secret === "string")
      void decodeReactions(reactions, target.id, secret, {
        open: (row) => vault.open(row),
        image: validateCustomEmojiPixels,
        current: () => alive && mounted.current && current.current === identity,
      }).then((entries) => {
        if (alive && current.current === identity && generation === decodeGeneration.current && !pendingRef.current)
          setOpened({ identity, entries });
      });
    return () => {
      alive = false;
    };
  }, [JSON.stringify(reactions), payload?.reactionSecret, identity]);
  const isComment = target.envelope.context.kind === "comment";
  const base = isComment
    ? `/comments/${target.id}/reactions`
    : `/posts/${target.id}/reactions`;
  function updatePending(value: PendingReaction | null) {
    pendingRef.current = value; setPending(value);
  }
  const valid = (operation: PendingReaction) => mounted.current && current.current === operation.identity;
  async function readConfirmed(operation: PendingReaction) {
    const detail = await get(`/posts/${isComment ? target.post_id : target.id}`);
    const rows = isComment ? (detail.comment_reactions || []).filter((row: Json) => row.comment_id === target.id) : detail.reactions || [];
    return decodeReactions(rows, target.id, payload!.reactionSecret as string, {
      open: row => vault.open(row), image: validateCustomEmojiPixels, current: () => valid(operation),
    });
  }
  async function settle(operation: PendingReaction, retry = false) {
    try {
      let entries = await readConfirmed(operation);
      if (!valid(operation)) return;
      const matches = (rows: DecodedReaction[]) => rows.some(entry => entry.memberId === vault.member.id && entry.tag === operation.tag) !== operation.removing;
      if (!matches(entries) && retry && operation.send) {
        // Replay the same PUT/DELETE intent, never toggle from an uncertain UI.
        await operation.send(); entries = await readConfirmed(operation);
      }
      if (!valid(operation)) return;
      if (!matches(entries)) throw new Error("The reaction is not confirmed yet. Check and retry to safely finish saving it.");
      ++decodeGeneration.current;
      setOpened({ identity, entries }); updatePending(null);
      // Refresh the parent's other data without hiding this confirmed result.
      void reload().catch(() => {});
    } catch (error) {
      if (!valid(operation)) return;
      if (accessLost(error)) { setOpened({identity, entries: []}); updatePending(null); }
      else updatePending({...operation, uncertain: true});
      throw error;
    }
  }
  async function toggle(value: ReactionPayload) {
    if (!payload || typeof payload.reactionSecret !== "string" || changing.current || activePending || vault.member.status === "restricted") return;
    changing.current = true;
    await action.runSave(async () => {
      let operation: PendingReaction | null = null;
      let dispatched = false;
      try {
        const chosen = await validateReactionPayload(value);
        if ("custom" in chosen) await validateCustomEmojiPixels(chosen);
        if (!mounted.current || current.current !== identity) return;
        const mine = confirmed.find(entry => entry.payload.emoji === chosen.emoji && entry.memberId === vault.member.id);
        operation = {identity, value: chosen, removing: !!mine, tag: mine?.tag || "", uncertain: false};
        ++decodeGeneration.current;
        updatePending(operation); setPicker(false); setSuggested(null);
        restoreReactionFocus.current = true;
        if (mine) operation.send = () => del(`${base}/${encodeURIComponent(mine.tag)}`);
        else {
          const tag = await reactionTag({secret: payload.reactionSecret as string, targetId: target.id, memberId: vault.member.id, emoji: chosen.emoji});
          operation.tag = tag;
          const envelope = await vault.seal(chosen, {
            id: tag, kind: "reaction", audience: target.envelope.context.audience,
            parentId: target.id, groupId: target.group_id || target.envelope.context.groupId,
            expiresAt: target.effective_expires_at || target.expires_at,
          }, isComment ? target.post_id : target.id);
          operation.send = () => request(`${base}/${tag}`, {method: "PUT", body: JSON.stringify({envelope})});
        }
        if (!valid(operation)) return;
        dispatched = true;
        await operation.send();
        await settle(operation);
      } catch (error) {
        if (!operation || !valid(operation)) { if (!operation) throw error; return; }
        const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
        if (!dispatched || rejected) {
          updatePending(null);
          if (accessLost(error)) setOpened({identity, entries: []});
        } else {
          updatePending({...operation, uncertain: true});
          // A lost response may follow a committed write. Read before offering any retry.
          try { await settle(operation); if (!pendingRef.current) return; } catch { /* Retain uncertain intent. */ }
        }
        throw error;
      }
    });
    changing.current = false;
  }
  return (
    <div className="reaction-area">
      <div className="reaction-chips">
        <ReactionChips key={identity} viewerId={vault.member.id}
          entries={decoded.map(entry=>({...entry,handle:entry.memberId===vault.member.id?vault.member.handle:reactions.find(row=>row.member_id===entry.memberId)?.author_handle}))}
          confirmed={(typeof payload?.reactionSecret==='string'?confirmed:[]).map(entry=>({...entry,handle:entry.memberId===vault.member.id?vault.member.handle:reactions.find(row=>row.member_id===entry.memberId)?.author_handle}))}
          disabled={action.busy||!!activePending||vault.member.status==='restricted'} onToggle={toggle}
          onSave={value=>{if('custom' in value){setSuggested(value);setPicker(true);}}}/>
        <button
          type="button"
          ref={addButton}
          className="reaction-add"
          onClick={() => {
            setSuggested(null);
            setPicker(true);
          }}
          disabled={action.busy || !!activePending || !payload || vault.member.status === "restricted"}
          aria-label="Add a reaction"
          aria-expanded={picker}
        >
          <Icon name="smile" size={18} />
          <Icon name="plus" size={10} />
        </button>
      </div>
      {picker && (
        <EmojiPicker
          key={identity}
          onSelect={toggle}
          onClose={() => {
            setPicker(false);
            setSuggested(null);
          }}
          busy={action.busy}
          error={action.error}
          suggested={suggested}
          returnFocusRef={addButton}
        />
      )}
      {activePending && <span ref={pendingStatus} tabIndex={-1} role="status">{activePending.uncertain ? "Reaction not yet confirmed." : "Saving reaction…"}</span>}
      {activePending?.uncertain && <button disabled={action.busy} onClick={() => void action.runSave(() => settle(activePending, true))}>Check and retry reaction</button>}
      {!picker && action.error && <Alert>{action.error}</Alert>}
    </div>
  );
}
export function Comments({
  postRow,
  details,
  onChange,
  canModerate = false,
}: {
  postRow: SocialObject;
  details: Json | null;
  onChange: () => Promise<void>;
  canModerate?: boolean;
}) {
  const comments = (details?.comments || []) as SocialObject[];
  const reactions = (details?.comment_reactions || details?.reactions || []) as Json[];
  const [reply, setReply] = useState<SocialObject | null>(null);
  const [tick, setTick] = useState(0);
  const action = useAction();
  async function refresh() {
    await action.run(async () => {
      try { await onChange(); }
      catch (e) {
        if (accessLost(e)) setReply(null);
        throw e;
      }
    });
  }
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [postRow.id]);
  const visible = comments.filter(unexpired);
  const roots = visible.filter(
    (c) => !c.parent_id || c.parent_id === postRow.id,
  );
  function branch(row: SocialObject, depth = 0): React.ReactNode {
    return (
      <div
        className={`comment-branch depth-${Math.min(depth, 2)}`}
        key={row.id}
      >
        <Comment
          row={row}
          postRow={postRow}
          canModerate={canModerate}
          onReply={() => setReply(row)}
          onChange={refresh}
          reactions={reactions.filter(
            (r) =>
              r.comment_id === row.id ||
              r.envelope?.context.parentId === row.id,
          )}
        />
        {visible
          .filter((c) => c.parent_id === row.id)
          .map((c) => branch(c, depth + 1))}
      </div>
    );
  }
  return (
    <section className="comments" aria-label="Comments">
      <Alert>{action.error}</Alert>
      {roots.map((c) => branch(c))}
      {reply && (
        <div className="reply-context">
          Replying to a comment{" "}
          <button className="text-button" onClick={() => setReply(null)}>
            Cancel
          </button>
        </div>
      )}
      <CommentComposer
        parent={reply || postRow}
        postRow={postRow}
        onPosted={async () => {
          setReply(null);
          await refresh();
        }}
      />
    </section>
  );
}
function Comment({
  row,
  postRow,
  onReply,
  onChange,
  reactions,
  canModerate = false,
}: {
  row: SocialObject;
  postRow: SocialObject;
  onReply: () => void;
  onChange: () => Promise<void>;
  reactions: Json[];
  canModerate?: boolean;
}) {
  const vault = useVault();
  const resolveMentions = useMentionResolver();
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [tags,setTags]=useState<PersonTag[]>([]);
  const [timer, setTimer] = useState("inherit");
  const action = useAction();
  useEffect(() => {
    vault
      .open(row)
      .then((c) => {
        setContent(c);setTags(validTags(c.tags));
        setText(c.text || "");
      })
      .catch((e) => setError(e.message));
  }, [row.envelope.ciphertext]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const expiresAt = deadline(
        timer,
        row.effective_expires_at || row.expires_at,
      );
      const envelope = await vault.seal(
        { ...content, text, tags:await resolveMentions(text,tags) },
        {
          ...row.envelope.context,
          authorDeviceId: vault.device.id,
          expiresAt,
          revision: row.envelope.context.revision + 1,
        },
        postRow.id,
      );
      const lifecycle = await signStatement(
        {
          purpose: "porchday-lifecycle",
          id: row.id,
          revision: envelope.context.revision,
          expiresAt,
        },
        vault.privateKey,
      );
      await request(`/comments/${row.id}`, {
        method: "PUT",
        body: JSON.stringify({ envelope, lifecycle }),
      });
      setEditing(false);
      await onChange();
    });
  }
  return (
    <div className="comment">
      <MemberAvatar memberId={row.author_id} name={row.author_handle || "?"} size="small" />
      <div className="comment-main">
        {editing ? (
          <form className="form-stack" onSubmit={save}>
            <label className="field">
              <span>Edit your comment</span>
              <textarea data-diagnostic-input="social-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={5000}
                required
              />
            </label>
            <TagPicker text={text} value={tags} onChange={setTags} disabled={action.busy}/>
            <ExpiryWarning
              expiry={row.effective_expires_at || row.expires_at}
              reply={!!row.parent_id}
              fromPost={row.effective_expires_at === postRow.expires_at}
            />
            <TimerSelect
              value={timer}
              onChange={setTimer}
              parent={row.effective_expires_at || row.expires_at}
            />
            <div className="button-row">
              <Button variant="primary compact" busy={action.busy}>
                Save
              </Button>
              <Button
                type="button"
                variant="quiet compact"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="comment-bubble">
            <div>
              <strong>
                {row.author_id === vault.member.id
                  ? `@${vault.member.handle}`
                  : row.author_handle
                    ? `@${row.author_handle}`
                    : "Member"}
              </strong>
              <time title={localDate(row.created_at)}>
                {relativeDate(row.created_at)}
              </time>
            </div>
            <p>{error || (content ? <PostText text={String(content.text||"")} tags={content.tags}/> : "Opening encrypted comment…")}</p>
            {!error && <Tags value={content?.tags}/>}
            {(row.effective_expires_at || row.expires_at) && (
              <small>
                <Icon name="clock" size={11} />
                {remaining(row.effective_expires_at || row.expires_at!)}
              </small>
            )}
          </div>
        )}
        <div className="comment-tools">
          <Reactions
            target={{ ...row, post_id: postRow.id }}
            payload={content}
            reactions={reactions}
            reload={onChange}
          />
          <button
            className="text-button"
            disabled={vault.member.status === "restricted"}
            onClick={onReply}
          >
            Reply
          </button>
          <button className="text-button" onClick={() => setReport(true)}>
            Report
          </button>
          {row.author_id === vault.member.id &&
            vault.member.status !== "restricted" && (
              <button className="text-button" onClick={() => {setTags(validTags(content?.tags));setText(String(content?.text||""));setEditing(true);}}>
                Edit
              </button>
            )}
          {(row.author_id === vault.member.id ||
            postRow.author_id === vault.member.id ||
            canModerate) &&
            vault.member.status !== "restricted" && (
              <button
                className="text-button"
                disabled={action.busy}
                onClick={() => {
                  if (confirm("Delete this comment and its replies?"))
                    action.run(async () => {
                      await del(`/comments/${row.id}`);
                      await onChange();
                    });
                }}
              >
                Delete
              </button>
            )}
        </div>
        <Alert>{action.error}</Alert>
      </div>
      {report && (
        <ReportDialog
          row={row}
          content={content}
          onClose={() => setReport(false)}
        />
      )}
    </div>
  );
}
function CommentComposer({
  parent,
  postRow,
  onPosted,
}: {
  parent: SocialObject;
  postRow: SocialObject;
  onPosted: () => Promise<void>;
}) {
  const vault = useVault();
  const resolveMentions = useMentionResolver();
  const [text, setText] = useState("");
  const [tags,setTags]=useState<PersonTag[]>([]);
  const [timer, setTimer] = useState("inherit");
  const [ack, setAck] = useState(
    parent.effective_expires_at || parent.expires_at || postRow.expires_at,
  );
  const action = useAction();
  useEffect(() => {
    setAck(
      parent.effective_expires_at || parent.expires_at || postRow.expires_at,
    );
    setTimer("inherit");
    action.setError("");
  }, [parent.id, parent.expires_at, parent.effective_expires_at]);
  const reply = parent.id !== postRow.id;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      try {
        const expiresAt = deadline(timer === "inherit" ? "" : timer, ack);
        const envelope = await vault.seal(
          { text: text.trim(), tags:await resolveMentions(text,tags), reactionSecret: createReactionSecret() },
          {
            kind: "comment",
            audience: postRow.envelope.context.audience,
            parentId: parent.id,
            groupId: postRow.group_id || null,
            expiresAt,
          },
          postRow.id,
        );
        await post(`/posts/${postRow.id}/comments`, {
          envelope,
          parent_expires_at: ack,
        });
        setText("");setTags([]);
        setTimer("inherit");
        await onPosted();
      } catch (e: any) {
        if (
          e.code === "DEADLINE_CHANGED" ||
          e.code === "PARENT_DEADLINE_CHANGED"
        ) {
          setAck(
            e.details?.effective_expires_at || e.details?.expires_at || null,
          );
          throw new Error(
            "The parent’s timer changed. Review the updated deadline below, then submit again.",
          );
        }
        throw e;
      }
    });
  }
  if (vault.member.status === "restricted") return null;
  return (
    <form
      className="comment-composer"
      data-unsaved-draft={Boolean(text.trim()) || undefined}
      onSubmit={submit}
    >
      <ExpiryWarning
        expiry={ack}
        reply={reply}
        fromPost={reply && ack === postRow.expires_at}
      />
      <div className="comment-compose-row">
        <MemberAvatar memberId={vault.member.id} name={vault.member.handle} size="small" />
        <label className="sr-only" htmlFor={`comment-${parent.id}`}>
          {reply ? "Write a reply" : "Write a comment"}
        </label>
        <textarea data-diagnostic-input="social-text"
          id={`comment-${parent.id}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={5000}
          rows={2}
          placeholder={reply ? "Write a reply…" : "Write a comment…"}
          required
        />
      </div>
      <TagPicker text={text} value={tags} onChange={setTags} disabled={action.busy}/>
      <Alert>{action.error}</Alert>
      <div className="comment-compose-footer">
        <TimerSelect value={timer} onChange={setTimer} parent={ack} />
        <Button
          variant="primary compact"
          busy={action.busy}
          disabled={!text.trim()}
        >
          {reply ? "Reply" : "Comment"}
          <Icon name="arrow" size={15} />
        </Button>
      </div>
    </form>
  );
}
export function ReportDialog({
  row,
  content,
  onClose,
  returnFocusRef,
}: {
  row: SocialObject;
  content: Content | null;
  onClose: () => void;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const vault = useVault();
  const [reason, setReason] = useState("harassment");
  const [description, setDescription] = useState("");
  const [disclose, setDisclose] = useState(false);
  const [done, setDone] = useState(false);
  const action = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      let evidence: EncryptedEnvelope | undefined;
      if (disclose) {
        evidence = await vault.seal(
          {
            selectedText: content?.text || "",
            description,
            sourceId: row.id,
            sourceAuthorId: row.author_id,
          },
          { kind: "report", audience: "moderators", parentId: row.id },
        );
      }
      await post("/reports", {
        target_member: row.author_id,
        target_id: row.id,
        reason,
        evidence_envelope: evidence || null,
        evidence_disclosed: !!evidence,
      });
      setDone(true);
    });
  }
  return (
    <Modal
      title="Tell us what’s wrong"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
    >
      {done ? (
        <>
          <Alert success>
            Your report was received. A moderator can review the information you
            chose to share.
          </Alert>
          <Button variant="primary" autoFocus onClick={onClose}>
            Done
          </Button>
        </>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <p>
            Reporting shares information with authorized moderators. They cannot
            otherwise read private content.
          </p>
          <label className="field">
            <span>What’s the concern?</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="harassment">Harassment or threats</option>
              <option value="agent">An AI agent or automated account</option>
              <option value="impersonation">Impersonation</option>
              <option value="spam">Spam or commercial promotion</option>
              <option value="safety">Safety or exploitation</option>
              <option value="other">Something else</option>
            </select>
          </label>
          <label className="field">
            <span>Anything else?</span>
            <textarea data-diagnostic-input="social-text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="Do not include passwords, recovery secrets, or other people’s private details."
            />
          </label>
          {
            <label className="check-field">
              <input
                type="checkbox"
                checked={disclose}
                onChange={(e) => setDisclose(e.target.checked)}
              />
              <span>
                Disclose my description and any readable selected text,
                encrypted for moderators.
              </span>
            </label>
          }
          <div className="report-preview">
            <strong>What will be shared</strong>
            <p>
              Category, the content reference, author reference, and your
              reporter identity.
              {!disclose &&
                " Your description is not sent unless you choose to disclose encrypted evidence."}
            </p>
            {disclose && (
              <blockquote>{String(content?.text || "(No text)")}</blockquote>
            )}
            <small>
              Photos, unrelated comments, and other private content are not
              included.
            </small>
          </div>
          <Alert>{action.error}</Alert>
          <Button variant="primary" busy={action.busy}>
            Send report
          </Button>
        </form>
      )}
    </Modal>
  );
}

function ReshareDialog({
  source,
  content,
  onClose,
  onShared,
}: {
  source: SocialObject;
  content: Content;
  onClose: () => void;
  onShared: () => void;
}) {
  const vault = useVault();
  const [text, setText] = useState(String(content.text || ""));
  const [audience, setAudience] = useState<Audience>(
    source.group_id ? "group" : "connections",
  );
  const [timer, setTimer] = useState("inherit");
  const [ack, setAck] = useState(
    source.effective_expires_at || source.expires_at,
  );
  const [reviewed, setReviewed] = useState(false);
  const action = useAction();
  async function share(e: React.FormEvent) {
    e.preventDefault();
    if (!reviewed) return;
    await action.run(async () => {
      try {
        const fresh = (await get(`/posts/${source.id}`)).post as SocialObject;
        const latest = fresh.effective_expires_at || fresh.expires_at;
        if (latest !== ack) {
          setAck(latest);
          setReviewed(false);
          throw new Error(
            "The original timer changed. Review the updated deadline and audience, then confirm again.",
          );
        }
        const expiresAt = reshareDeadline(fresh, timer, vault.member.id);
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        const groupId = audience === "group" ? source.group_id || null : null;
        const media: MediaPayload[] = [];
        for (const photo of content.media || []) {
          const response = await fetch(`/api/v1/media/${photo.id}/bytes`, {
            credentials: "same-origin",
            cache: "no-store",
          });
          if (!response.ok)
            throw new Error(
              "An original photo is unavailable. This memory cannot be shared again.",
            );
          const oldEnvelope = (await response.json()) as EncryptedEnvelope;
          const original = await vault.open({
            envelope: oldEnvelope,
            id: photo.id,
          });
          if (
            (!isVideo(original.mime) && original.mime !== "image/jpeg") ||
            original.videoVersion!==2&&typeof original.bytes !== "string"
          )
            throw new Error("An original photo has an unsupported format.");
          const video=original.videoVersion===2?validateVideoManifest(original.video):undefined;
          const {width,height}=video||await validatedMedia(base64ToBytes(original.bytes as string),original.mime as string);
          const photoExpiresAt = preservedPhotoDeadline(
            oldEnvelope.context.expiresAt,
            expiresAt,
          );
          const item = { ...photo, width, height, posterExpiresAt: photoExpiresAt, id: crypto.randomUUID() };
          const envelope = await vault.seal(
            { ...item, ...(video?{video,bytes:videoUpdatePlaceholder}:{bytes:original.bytes}) },
            {
              id: item.id,
              kind: "media",
              audience,
              parentId: id,
              groupId,
              createdAt,
              expiresAt: photoExpiresAt,
            },
          );
          const packed = new TextEncoder().encode(JSON.stringify(envelope));
          const upload = await post(video?"/videos":"/media", {
            id: item.id,
            envelope,
            byte_size: packed.length,...(video?{stream_id:video.streamId}:{}),
          });
          await request(upload.upload_url, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Blob([packed]),
          });
          media.push(item);
        }
        const payload = resharePayload(fresh, content, text, media);
        const envelope = await vault.seal(payload, {
          id,
          kind: "post",
          audience,
          groupId,
          createdAt,
          expiresAt,
        });
        await post(`/posts/${source.id}/reshare`, {
          envelope,
          media_ids: media.map((m) => m.id),
          source_expires_at: ack,
        });
        onShared();
      } catch (e: any) {
        if (
          e.code === "PARENT_DEADLINE_CHANGED" ||
          e.code === "SOURCE_DEADLINE_CHANGED"
        ) {
          setAck(e.details?.expires_at || null);
          setReviewed(false);
          throw new Error(
            "The original timer changed. Review the updated deadline and audience, then confirm again.",
          );
        }
        throw e;
      }
    });
  }
  return (
    <Modal title="Share as a new post" onClose={onClose}>
      <form className="form-stack" onSubmit={share}>
        <p>
          This creates a new post for your selected current audience, including
          eligible people who connected with you later. Only your own text and
          photos are copied. The original comments and reactions stay with the
          original post.
        </p>
        <label className="field">
          <span>Your text</span>
          <textarea data-diagnostic-input="social-text"
            rows={4}
            maxLength={5000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {!!content.media?.length && (
          <p>
            {content.media.length} of your photos will be encrypted again for
            the new audience.
          </p>
        )}
        <label className="field">
          <span>New post audience</span>
          <select
            value={audience}
            onChange={(e) => {
              setAudience(e.target.value as Audience);
              setReviewed(false);
            }}
          >
            <option value="connections">My current friends & family</option>
            <option value="friends">Friends only</option>
            <option value="family">My current family connections</option>
            <option value="extended_family">Extended family</option>
              <option value="community">Community</option>
              <option value="only_me">Only me</option>
            {source.group_id && (
              <option value="group">Current members of this group</option>
            )}
          </select>
        </label>
        {ack && (
          <div className="timer-warning">
            <Icon name="clock" />
            <span>
              The copy keeps the original deadline:{" "}
              <strong>{localDate(ack)}</strong>. You can make it shorter, never
              longer.
            </span>
          </div>
        )}
        <TimerSelect
          value={timer}
          onChange={(v) => {
            setTimer(v);
            setReviewed(false);
          }}
          parent={ack}
        />
        <p className="small-copy">
          The new post has its own thread. Later editing, shortening, or
          deleting the original does not change this copy. The original author
          and date stay in its provenance.
        </p>
        <label className="check-field">
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
            required
          />
          <span>
            I reviewed the new audience and expiration and want to share my
            contribution again.
          </span>
        </label>
        <Alert>{action.error}</Alert>
        <div className="button-row">
          <Button
            variant="primary"
            busy={action.busy}
            disabled={!reviewed || (!text.trim() && !content.media?.length)}
          >
            Share as a new post
          </Button>
          <Button type="button" variant="quiet" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReshareProvenance({ content }: { content: Content }) {
  const provenance = content.provenance as Json | undefined;
  if (
    provenance?.kind !== "reshared_post" ||
    typeof provenance.created_at !== "string" ||
    !Number.isFinite(Date.parse(provenance.created_at))
  )
    return null;
  return (
    <p className="small-copy">
      <Icon name="clock" size={13} /> Originally posted on{" "}
      {localDate(provenance.created_at)}, shared again by its author.
    </p>
  );
}
