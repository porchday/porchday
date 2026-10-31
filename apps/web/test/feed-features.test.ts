import {describe,it,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FeedFeatureCard,mergeFeedFeatures,featurePreview} from '../src/FeedFeatures';
const feature={id:'feature',title:'A proposal',plan:'Short plan',created_at:'2026-10-30T10:00:00Z',status:'voting',score:2,my_vote:-1};
describe('feed feature presentation',()=>{
 it('merges independent pages deterministically without duplicates or ID collisions',()=>{
  const posts=[{id:'feature',created_at:feature.created_at},{id:'older',created_at:'2026-10-29T10:00:00Z'}] as any;
  const result=mergeFeedFeatures(posts,[feature,feature]);
  expect(result.map(x=>x.kind+':'+x.row.id)).toEqual(['feature:feature','post:feature','post:older']);
  expect(mergeFeedFeatures([...posts].reverse(),[feature])).toEqual(result);
  const tied=[{id:'z',created_at:feature.created_at},{id:'a',created_at:feature.created_at}] as any;
  expect(mergeFeedFeatures(tied,[feature]).filter(x=>x.kind==='post').map(x=>x.row.id)).toEqual(['z','a']);
 });
 it('shows the shared vote, controls and deep link without expanding',()=>{
  const html=renderToStaticMarkup(createElement(FeedFeatureCard,{feature,busy:false,onVote:()=>{}}));
  expect(html).toContain('Your vote: Against');expect(html).toContain('Remove my vote');expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('/app/features?proposal=feature#feature-feature');expect(html).toContain('+2');
 });
 it('locks controls on queued cards and while refreshing or paused',()=>{
  const render=(patch:any,busy=false)=>renderToStaticMarkup(createElement(FeedFeatureCard,{feature:{...feature,...patch},busy,onVote:()=>{}}));
  expect(render({status:'queued'})).not.toContain('Support +1');expect(render({},true)).toContain('disabled');
 });
 it('bounds plain text previews and recognizes structured summaries without injecting markup',()=>{
  expect(featurePreview('x'.repeat(1000))).toHaveLength(240);
  expect(featurePreview('Proposal overview v1\nSummary: Short summary\n\nHighlights:')).toBe('Short summary');
  const html=renderToStaticMarkup(createElement(FeedFeatureCard,{feature:{...feature,plan:'<script>x</script>'},busy:false,onVote:()=>{}}));
  expect(html).toContain('&lt;script&gt;');
 });
});
