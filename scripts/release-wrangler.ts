import {createHash} from 'node:crypto';
import {constants,closeSync,fsyncSync,lstatSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
const CLI_VERSION="4.152.0";
const CLI_SHA256="f2d6a86faba5718912acbb5d3d2d3877095307a67f2c4503387e3b5e417fa150";
const CLI_INTEGRITY="sha512-lmXTF1sCDEqBaEMpreGczvg/x3AIh1d/qxc4BN7utQ4jEDwdA4YG0L6kr3ev0TtVLHRb6QLySNAOAunwn+dHeA==";
const VERSION_POST_ORIGINAL="const result = await retryOnAPIFailure(\n        async () => fetchResult(\n          config2,\n          `${workerUrl}/versions`,\n          {\n            method: \"POST\",\n            body: workerBundle,\n            headers: props.sendMetrics ? { metricsEnabled: \"true\" } : void 0\n          },\n          new URLSearchParams({ bindings_inherit: \"strict\" })\n        ),\n        logger\n      );";
const VERSION_POST_ONCE="const result = await (async () => fetchResult(\n          config2,\n          `${workerUrl}/versions`,\n          {\n            method: \"POST\",\n            body: workerBundle,\n            headers: props.sendMetrics ? { metricsEnabled: \"true\" } : void 0\n          },\n          new URLSearchParams({ bindings_inherit: \"strict\" })\n        ))();";
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export type ReleaseWranglerReceipt={version:string;integrity:string;lockSha256:string;packageSha256:string;originalSha256:string;patchedSha256:string;path:string};
/** Exact reviewed patch: asset retries remain; version creation is invoked once. */
export function patchReleaseWrangler(original:Buffer):Buffer{
 if(sha(original)!==CLI_SHA256)throw Error('RELEASE_WRANGLER_UNREVIEWED');
 const source=original.toString('utf8');
 if(source.split(VERSION_POST_ORIGINAL).length!==2||source.includes(VERSION_POST_ONCE))throw Error('RELEASE_WRANGLER_WRAPPER_CHANGED');
 const patched=source.replace(VERSION_POST_ORIGINAL,VERSION_POST_ONCE);
 if(patched.replace(VERSION_POST_ONCE,VERSION_POST_ORIGINAL)!==source)throw Error('RELEASE_WRANGLER_PATCH_INVALID');
 return Buffer.from(patched);
}
function regular(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('RELEASE_WRANGLER_FILE_INVALID');return readFileSync(path);}
function inputs(workspace:string){
 if(!isAbsolute(workspace))throw Error('RELEASE_WRANGLER_PATH_INVALID');
 const lockBytes=regular(join(workspace,'package-lock.json')),packageBytes=regular(join(workspace,'node_modules/wrangler/package.json'));
 const lock=JSON.parse(lockBytes.toString()).packages?.['node_modules/wrangler'],installed=JSON.parse(packageBytes.toString());
 if(lock?.version!==CLI_VERSION||installed.version!==CLI_VERSION||lock.integrity!==CLI_INTEGRITY||lock.resolved!==`https://registry.npmjs.org/wrangler/-/wrangler-${CLI_VERSION}.tgz`)throw Error('RELEASE_WRANGLER_PACKAGE_CHANGED');
 const original=regular(join(workspace,'node_modules/wrangler/wrangler-dist/cli.js')),patched=patchReleaseWrangler(original),patchedSha256=sha(patched);
 const path=join(workspace,'node_modules/wrangler/wrangler-dist/porchday-release-'+patchedSha256+'.js');
 return{patched,receipt:{version:CLI_VERSION,integrity:CLI_INTEGRITY,lockSha256:sha(lockBytes),packageSha256:sha(packageBytes),originalSha256:CLI_SHA256,patchedSha256,path}};
}
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
/** Local preparation only; never runs Wrangler or contacts a provider. */
export function prepareReleaseWrangler(workspace:string):ReleaseWranglerReceipt{
 const {patched,receipt}=inputs(workspace);
 let fd:number;
 try{fd=openSync(receipt.path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;verifyReleaseWrangler(workspace,receipt);return receipt;}
 try{writeFileSync(fd,patched);fsyncSync(fd);}finally{closeSync(fd);}
 syncDirectory(join(workspace,'node_modules/wrangler/wrangler-dist'));verifyReleaseWrangler(workspace,receipt);return receipt;
}
/** Recheck immediately before dispatch; a receipt is not perpetual authorization. */
export function verifyReleaseWrangler(workspace:string,receipt:ReleaseWranglerReceipt):string{
 const expected=inputs(workspace);
 if(Object.keys(receipt).sort().join(',')!==Object.keys(expected.receipt).sort().join(',')||Object.entries(expected.receipt).some(([key,value])=>receipt[key as keyof ReleaseWranglerReceipt]!==value))throw Error('RELEASE_WRANGLER_RECEIPT_CHANGED');
 const stat=lstatSync(receipt.path);
 if(stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||!regular(receipt.path).equals(expected.patched))throw Error('RELEASE_WRANGLER_PATCH_CHANGED');
 return receipt.path;
}
