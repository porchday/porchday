/** Local, curated artwork only. Never use profile values as URLs or CSS. */
export const WALLPAPERS = [
  { id: 'porch-stars', label: 'Stars & arrows', description: 'A noisy little orange night sky' },
  { id: 'orange-checker', label: 'Kitchen table', description: 'Warm checks and tiny diamonds' },
  { id: 'sunny-daisies', label: 'Daisy chain', description: 'Orange flowers on sunny paper' },
  { id: 'midnight-diamonds', label: 'Midnight diamonds', description: 'Cream gems on deep chocolate' },
] as const;
export type WallpaperId = typeof WALLPAPERS[number]['id'];
export function wallpaperId(value: unknown): WallpaperId | 'none' {
  return WALLPAPERS.some((wallpaper) => wallpaper.id === value)
    ? value as WallpaperId
    : 'none';
}
