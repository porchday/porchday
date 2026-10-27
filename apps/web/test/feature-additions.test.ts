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
