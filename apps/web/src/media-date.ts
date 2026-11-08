import exifr from 'exifr';

/** Keep the camera's calendar day, without converting it to the viewer's timezone. */
export function captureDay(value: unknown): string | undefined {
  if(typeof value !== 'string') return;
  const match = /^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T]|$)/.exec(value);
  if(!match) return;
  const [,year,month,day] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(date+'T12:00:00Z');
  if(Number(year)<1 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date) return;
  return date;
}

/** Read only creation metadata, before image normalization strips private EXIF. */
export async function photoCaptureDate(file: Blob): Promise<string> {
  try {
    const tags = await exifr.parse(file, {
      pick: ['DateTimeOriginal','CreateDate','DateCreated'],
      reviveValues: false, gps: false, xmp: true,
    });
    return captureDay(tags?.DateTimeOriginal) || captureDay(tags?.CreateDate) || captureDay(tags?.DateCreated) || '';
  } catch { return ''; }
}
