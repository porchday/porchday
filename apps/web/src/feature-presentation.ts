/** Presentation only: never edits a proposal's authoritative text or voting state. */
export type ProposalOverview = { summary: string; highlights: string[]; original: string; reviewed: boolean };
export function proposalOverview(plan: string): ProposalOverview {
  // Only the explicit versioned envelope is trusted as a reviewed overview.
  // Older prose is not automatically shortened: important qualifications may be anywhere.
  const match = /^Proposal overview v1\nSummary: ([^\n]+)\n\nHighlights:\n([\s\S]*?)\n\nOriginal plan:\n([\s\S]+)$/.exec(plan);
  if (match) {
    const highlights = match[2].split('\n').map(line => /^- (.+)$/.exec(line)?.[1]);
    if (match[1].trim() && match[1].length <= 600 && highlights.length <= 3 && highlights.length >= 1 && highlights.every(line => line && line.length <= 400))
      return {summary:match[1],highlights:highlights as string[],original:match[3],reviewed:true};
  }
  return {summary:'This proposal needs a reviewed summary. Read the original plan before voting.',highlights:[],original:plan,reviewed:false};
}
export type ProposalSection = { title: string; text: string };
const categories: [RegExp,string][] = [
  [/^(source|sources|attribution|administrative|current board status|voting status|status: tracked)/i,'Sources and history'],
  [/^(acceptance|tests?|validation)/i,'Acceptance and testing'],
  [/^(approach|implementation|technical|deployment|rollback|art, sound|puzzle)/i,'Approach and rollout'],
];
export function proposalSections(original: string): ProposalSection[] {
  const groups = new Map<string,string[]>();
  let category = 'Scope and details';
  for (const paragraph of original.split(/\n\s*\n/)) {
    const heading = paragraph.trim().split('\n')[0];
    const found = categories.find(([pattern])=>pattern.test(heading));
    if (found) category=found[1];
    else if (/^(scope|experience|proposal:|requested behavior|plan:|plan for approval|what changes|audience)/i.test(heading)) category='Scope and details';
    // Provenance applies to its own paragraph, never to subsequent product requirements.
    const target=category;
    if (!groups.has(target)) groups.set(target,[]);
    groups.get(target)!.push(paragraph);
    if (target==='Sources and history') category='Scope and details';
  }
  return ['Scope and details','Acceptance and testing','Approach and rollout','Sources and history']
    .filter(title=>groups.has(title)).map(title=>({title,text:groups.get(title)!.join('\n\n')}));
}
