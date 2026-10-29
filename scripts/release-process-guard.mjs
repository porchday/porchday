// Loaded before Wrangler. A dead controller must not leave an unattended uploader.
if(!process.connected||typeof process.send!=='function')throw Error('RELEASE_PROCESS_IPC_REQUIRED');
process.umask(0o077);
process.once('disconnect',()=>process.exit(125));
process.channel?.unref();
