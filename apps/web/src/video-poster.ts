import type {Input} from 'mediabunny';

/** A thumbnail is optional; a stalled decoder must not discard a verified video. */
export async function videoPoster(file: File, signal: AbortSignal): Promise<string> {
 let input: Input | undefined;
 let finished = false;
 let timer: ReturnType<typeof setTimeout> | undefined;
 let abort: () => void = () => {};
 try {
  signal.throwIfAborted();
  const stopped = new Promise<string>((resolve, reject) => {
   timer = setTimeout(() => resolve(''), 3000);
   abort = () => reject(signal.reason ?? new DOMException('Canceled', 'AbortError'));
   signal.addEventListener('abort', abort, {once: true});
  });
  const frame = (async () => {
   const {Input, ALL_FORMATS, BlobSource, CanvasSink} = await import('mediabunny');
   if (finished) return '';
   input = new Input({formats: ALL_FORMATS, source: new BlobSource(file)});
   const track = await input.getPrimaryVideoTrack();
   if (!track || finished) return '';
   const width = await track.getDisplayWidth(), height = await track.getDisplayHeight();
   if (finished) return '';
   const scale = Math.min(1, 320 / Math.max(width, height));
   const sink = new CanvasSink(track, {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), fit: 'contain'});
   const sample = await sink.getCanvas(await track.getFirstTimestamp());
   if (!sample || finished) return '';
   const canvas = document.createElement('canvas');
   canvas.width = sample.canvas.width; canvas.height = sample.canvas.height;
   const context = canvas.getContext('2d');
   if (!context) return '';
   context.drawImage(sample.canvas, 0, 0);
   return canvas.toDataURL('image/jpeg', 0.7).split(',')[1] || '';
  })();
  return await Promise.race([frame, stopped]);
 } catch (error) {
  if (signal.aborted) throw signal.reason ?? error;
  return '';
 } finally {
  finished = true;
  clearTimeout(timer);
  signal.removeEventListener('abort', abort);
  input?.dispose();
 }
}
