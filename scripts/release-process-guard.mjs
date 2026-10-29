// Loaded before Wrangler. A dead controller must not leave an unattended uploader.
import {Socket} from 'node:net';
if(!process.connected||typeof process.send!=='function')throw Error('RELEASE_PROCESS_IPC_REQUIRED');
process.umask(0o077);
// Wrangler deliberately disconnects IPC in its own finally block. Use a separate
// inherited control pipe so normal cleanup cannot disable controller supervision.
const control=new Socket({fd:3,readable:true,writable:false});
control.on('end',()=>process.exit(125));
control.on('error',()=>process.exit(125));
control.resume();
control.unref();
process.channel?.unref();
