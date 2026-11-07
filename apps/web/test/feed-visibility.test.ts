import {describe,it,expect} from 'vitest';
import {FeedDwell,feedVisible} from '../src/feed-visibility';
describe('foreground feed dwell',()=>{
 it('requires one continuous second and restarts after hiding or flinging past',()=>{const d=new FeedDwell();expect(d.update(true,0)).toBe(false);expect(d.update(true,999)).toBe(false);expect(d.update(false,1000)).toBe(false);expect(d.update(true,2000)).toBe(false);expect(d.update(true,2999)).toBe(false);expect(d.update(true,3000)).toBe(true);});
 it('handles tall cards without requiring impossible half-card visibility',()=>{const viewport={width:400,height:800};expect(feedVisible({top:-100,bottom:1900,left:0,right:400,width:400,height:2000},viewport)).toBe(true);expect(feedVisible({top:600,bottom:2600,left:0,right:400,width:400,height:2000},viewport)).toBe(false);expect(feedVisible({top:0,bottom:100,left:500,right:600,width:100,height:100},viewport)).toBe(false);});
});
