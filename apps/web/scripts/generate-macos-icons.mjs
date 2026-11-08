// macOS does not mask legacy AppIcon PNGs like iOS does. Render the existing
// vector artwork inside an inset rounded tile, with transparent outer corners.
import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/icon.svg',import.meta.url),'utf8');
const artwork=source.replace('<svg ', '<svg x="16" y="16" width="160" height="160" ');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><defs><clipPath id="tile"><rect x="16" y="16" width="160" height="160" rx="36"/></clipPath><filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity=".18"/></filter></defs><rect x="16" y="16" width="160" height="160" rx="36" fill="#974013" filter="url(#shadow)"/><g clip-path="url(#tile)">${artwork}</g></svg>`;
const browser=await chromium.launch();
try{for(const size of [16,32,64,128,256,512,1024]){
 const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
 await page.route('**/*',r=>r.abort());
 await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
 await writeFile(new URL(`../../ios/Porchday/Assets.xcassets/AppIcon.appiconset/mac-${size}.png`,import.meta.url),await page.screenshot({omitBackground:true}));await page.close();
}}finally{await browser.close();}
