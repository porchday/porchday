import {proposalOverview} from '../apps/web/src/feature-presentation.ts';

export type ReviewedOverview = {id:string; original:string; summary:string; highlights:string[]};
export type OverviewChange = {id:string; before:string; after:string};

/** Explicit human-reviewed input only; never infer a summary from legacy prose. */
export function prepareOverviewChanges(entries:ReviewedOverview[]):OverviewChange[] {
  if (!Array.isArray(entries) || !entries.length || entries.length>100) throw Error('INVALID_REVIEW_BATCH');
  const ids=new Set<string>();
  return entries.map(entry=>{
    if (!entry || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entry.id) || ids.has(entry.id)) throw Error('INVALID_OR_DUPLICATE_ID');
    ids.add(entry.id);
    if (typeof entry.original!=='string' || !entry.original.trim() || proposalOverview(entry.original).reviewed) throw Error('INVALID_OR_ALREADY_WRAPPED_ORIGINAL');
    if (typeof entry.summary!=='string' || entry.summary.trim().split(/\s+/).length>40 || !Array.isArray(entry.highlights) || !entry.highlights.every(point=>typeof point==='string')) throw Error('INVALID_SUMMARY');
    const after=`Proposal overview v1\nSummary: ${entry.summary}\n\nHighlights:\n${entry.highlights.map(point=>`- ${point}`).join('\n')}\n\nOriginal plan:\n${entry.original}`;
    const view=proposalOverview(after);
    if (!view.reviewed || view.original!==entry.original || after.length>12000) throw Error('INVALID_OVERVIEW');
    return {id:entry.id,before:entry.original,after};
  });
}
