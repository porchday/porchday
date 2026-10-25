const messages={
 operational:{title:'All systems operational',description:'Porchday is responding normally to its service checks.'},
 degraded:{title:'Service needs attention',description:'Porchday is experiencing a service issue. Please try again later.'},
 checking:{title:'Checking service status',description:'The monitor is checking Porchday. Refresh this page shortly for an update.'},
 unknown:{title:'Status unavailable',description:'We cannot confirm Porchday’s current status. Please check again shortly.'},
} as const;
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));

/** The public page accepts only a fixed state and a valid date. Diagnostic
 * fields are never rendered, even if an internal response includes them. */
export function renderStatusPage(value:unknown,httpStatus=200):Response {
 const snapshot=value&&typeof value==='object'?value as Record<string,unknown>:{};
 const state=typeof snapshot.status==='string'&&Object.hasOwn(messages,snapshot.status)?snapshot.status as keyof typeof messages:'unknown';
 const message=messages[state];
 const date=typeof snapshot.last_checked_at==='string'?new Date(snapshot.last_checked_at):null;
 const checked=date&&Number.isFinite(date.getTime())?date:null;
 const nonce=crypto.randomUUID();
 const checkedAt=checked?`<time datetime="${escapeHtml(checked.toISOString())}">${escapeHtml(checked.toUTCString())}</time>`:'No completed check yet';
 const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Porchday service status</title>
<style nonce="${escapeHtml(nonce)}">
*{box-sizing:border-box}body{margin:0;background:#f6f3ea;color:#264c42;font:16px/1.6 Arial,Helvetica,sans-serif}main{width:min(100% - 40px,680px);margin:12vh auto 40px}.brand{font:bold 38px/1.1 Georgia,serif;letter-spacing:-1px;margin:0 0 10px}.eyebrow{font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 32px;color:#526b60}.card{background:#fffefa;border:1px solid #dfe3d8;border-radius:14px;padding:clamp(24px,5vw,40px)}.state{display:inline-block;padding:4px 12px;border-radius:20px;background:#e6eadc;font-size:13px;font-weight:bold}.state[data-state=degraded]{background:#f3e1d2}.state[data-state=unknown],.state[data-state=checking]{background:#e8e2ef}h1{font:normal clamp(27px,5vw,36px)/1.2 Georgia,serif;margin:18px 0 14px}p{margin:0 0 20px}.checked{border-top:1px solid #dfe3d8;margin-top:28px;padding-top:20px;font-size:14px}.checked strong{display:block}a{color:#264c42;text-underline-offset:4px}a:focus-visible{outline:3px solid #cf7258;outline-offset:4px}.links{display:flex;flex-wrap:wrap;gap:12px 24px;margin-bottom:0}footer{font-size:13px;margin-top:24px;color:#526b60}footer p{margin-bottom:10px}@media(prefers-reduced-motion:no-preference){a{transition:color .15s}}a:hover{color:#a34f37}
</style></head><body><main><header><p class="brand">Porchday</p><p class="eyebrow">Service status</p></header>
<section class="card" aria-labelledby="status-heading"><span class="state" data-state="${escapeHtml(state)}">${escapeHtml(state.charAt(0).toUpperCase()+state.slice(1))}</span><h1 id="status-heading">${escapeHtml(message.title)}</h1><p>${escapeHtml(message.description)}</p><p class="checked"><strong>Last checked</strong>${checkedAt}</p><p class="links"><a href="/">Refresh status</a><a href="/status">Status as JSON</a></p></section>
<footer><p>Independent service checks run every minute. This page shows the latest completed check; refresh to see an update.</p><p>Only overall availability is shown here. No member information is published.</p></footer></main></body></html>`;
 return new Response(html,{status:httpStatus,headers:{
  'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'content-security-policy':`default-src 'none'; script-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
 }});
}
