import {JOURNAL_PHASES} from '../apps/api/src/journal-phases';
const allowed=new Set<string>(JOURNAL_PHASES.map(phase=>'privacy_'+phase));
export type PrivacyWriteSpan={name:string;durationMs:number;startMs:number};
/** Retain only allowlisted numeric spans. Nested I/O overlaps parent phases;
 * missing spans are not zero, and no header identifiers are retained. */
export function privacyWriteTiming(header:string|null):PrivacyWriteSpan[]{
 const spans:PrivacyWriteSpan[]=[];
 for(const entry of (header??'').split(',')){
  const match=/^\s*pd-span;dur=([0-9]+(?:\.[0-9]+)?);desc="(privacy_[a-z0-9_]+)@([0-9]+(?:\.[0-9]+)?)"\s*$/.exec(entry);
  if(!match||!allowed.has(match[2]))continue;
  const durationMs=Number(match[1]),startMs=Number(match[3]);
  if(!Number.isFinite(durationMs)||durationMs>3_600_000||!Number.isFinite(startMs)||startMs>3_600_000)continue;
  spans.push({name:match[2],durationMs,startMs});
 }
 return spans;
}
