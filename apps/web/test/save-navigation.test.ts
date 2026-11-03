import {afterEach,expect,it,vi} from "vitest";
import {navigate,navigateAfterSaves} from "../src/ui";
import {withPendingSave} from "../src/pending-saves";

afterEach(()=>vi.unstubAllGlobals());
function browser(){
 const target=Object.assign(new EventTarget(),{scrollTo:vi.fn()});
 const location={href:"https://porchday.org/app/albums",origin:"https://porchday.org"};
 const pushState=vi.fn((_state:unknown,_title:string,path:string)=>{location.href=new URL(path,location.href).href;});
 vi.stubGlobal("window",target);vi.stubGlobal("location",location);vi.stubGlobal("history",{pushState});vi.stubGlobal("PopStateEvent",Event);
 return {target,pushState,location};
}
function held(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
it("redirects after a successful save without bypassing concurrent background writes",async()=>{
 const {pushState}=browser(),foreground=held(),background=held();
 const a=withPendingSave(()=>foreground.promise),b=withPendingSave(()=>background.promise,true);
 navigate("/app/albums/new");expect(pushState).not.toHaveBeenCalled();
 foreground.resolve();await a;
 navigateAfterSaves("/app/albums/new");expect(pushState).not.toHaveBeenCalled();
 background.resolve();await b;
 expect(pushState).toHaveBeenCalledExactlyOnceWith({},"","/app/albums/new");
});
it("does not pull the user back after another navigation",async()=>{
 const {target,pushState,location}=browser(),work=held();const saving=withPendingSave(()=>work.promise);
 navigateAfterSaves("/app/albums/new");location.href="https://porchday.org/app";target.dispatchEvent(new Event("popstate"));
 work.resolve();await saving;expect(pushState).not.toHaveBeenCalled();
});
it("redirects immediately when saves have already settled and supports cancellation",async()=>{
 const {pushState}=browser();navigateAfterSaves("/app/albums/new");expect(pushState).toHaveBeenCalledTimes(1);
 const work=held(),saving=withPendingSave(()=>work.promise);const cancel=navigateAfterSaves("/app/albums/other");cancel();work.resolve();await saving;expect(pushState).toHaveBeenCalledTimes(1);
});
