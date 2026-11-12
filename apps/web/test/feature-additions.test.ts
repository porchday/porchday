import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FeatureCard} from '../src/FeatureAdditions';
describe('feature additions',()=>{
 it('shows a plain-text plan, signed net score and the current vote',()=>{
  const html=renderToStaticMarkup(createElement(FeatureCard,{feature:{title:'Test',plan:'<script>no</script>',status:'voting',score:2,my_vote:-1,commits:[]},busy:false,onVote:()=>{}}));
  expect(html).toContain('&lt;script&gt;');expect(html).toContain('+2 / +3 needed');expect(html).toContain('aria-pressed="true"');expect(html).toContain('Remove my vote');
 });
 it('locks voting after dispatch and distinguishes code delivery from deployment',()=>{
  const html=renderToStaticMarkup(createElement(FeatureCard,{feature:{title:'Test',plan:'Plan',status:'delivered',score:3,my_vote:1,commits:[]},busy:false,onVote:()=>{}}));
  expect(html).not.toContain('Support +1');expect(html).toContain('deployment may still be pending');
 });
});

import {proposalOverview,proposalSections} from '../src/feature-presentation';
const original='Source: public reference\n\nAdministrative listing of a public draft.\n\nScope: one ticket permits implementation without a second vote.\n\nAcceptance: no duplicate redemption.\n\nDeployment: stage first.';
const structured='Proposal overview v1\nSummary: Delegate one surprise implementation.\n\nHighlights:\n- Removes the second feature-specific vote within approved limits.\n- Ticket expires and can be revoked before use.\n\nOriginal plan:\n'+original;
describe('proposal presentation',()=>{
 it('retains the exact original, including consequential policy scope',()=>{
  const view=proposalOverview(structured);
  expect(view.original).toBe(original);expect(view.reviewed).toBe(true);
  expect(view.highlights[0]).toContain('Removes the second');
  expect(proposalSections(view.original).find(s=>s.title==='Sources and history')!.text).toContain('Administrative listing');
  expect(proposalSections(view.original).find(s=>s.title==='Scope and details')!.text).toContain('without a second vote');
 });
 it('keeps voting outside collapsed details and preserves state',()=>{
  const feature={id:'fixed',title:'Delegation',plan:structured,status:'voting',score:2,my_vote:1,commits:[]};
  const before=JSON.stringify(feature);
  const html=renderToStaticMarkup(createElement(FeatureCard,{feature,busy:false,onVote:()=>{}}));
  expect(html.indexOf('Support +1')).toBeLessThan(html.indexOf('<details'));
  expect(html.slice(0,html.indexOf('<details'))).not.toContain('Administrative listing');
  expect(html).not.toContain('<details open');expect(html).toContain('<summary>Complete original plan</summary>');
  expect(JSON.stringify(feature)).toBe(before);
 });
 it.each(['', 'Summary: Looks harmless.\n\nHidden policy change.', structured.replace('Highlights:','Benefits:'),structured.replace('Delegate one surprise implementation.','x'.repeat(601))])('does not invent or truncate a summary for unsupported input',plan=>{
  const view=proposalOverview(plan);expect(view.reviewed).toBe(false);expect(view.original).toBe(plan);
 });
 it('keeps unknown and long detail paragraphs intact',()=>{
  const text='Unknown heading\n'+'long detail '.repeat(1000);
  expect(proposalSections(text)[0].text).toBe(text);
 });
 it('falls back to an expanded original for an unreviewed legacy plan',()=>{
  const html=renderToStaticMarkup(createElement(FeatureCard,{feature:{title:'Legacy',plan:original,status:'queued',score:3,my_vote:0},busy:false,onVote:()=>{}}));
  expect(html).toContain('<details open="">');expect(html).toContain('summary needs review');expect(html).not.toContain('Support +1');
 });
});
