export type Rect={top:number;bottom:number;left:number;right:number;width:number;height:number};
export function feedVisible(frame:Rect,viewport:{width:number;height:number}){
 return frame.width>0&&frame.height>0&&viewport.height>0&&frame.right>0&&frame.left<viewport.width&&Math.max(0,Math.min(frame.bottom,viewport.height)-Math.max(frame.top,0))>=Math.min(frame.height/2,viewport.height/2);
}
export class FeedDwell {
 private since:number|undefined;
 update(eligible:boolean,now:number){if(!eligible){this.since=undefined;return false;}this.since??=now;return now-this.since>=1000;}
}
