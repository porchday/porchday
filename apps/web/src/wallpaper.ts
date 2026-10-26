/** Local, curated artwork only. Never use profile values as URLs or CSS. */
export const WALLPAPERS = [
  { id: 'porch-stars', label: 'Stars & arrows', description: 'Orange stars and arrows' },
  { id: 'orange-checker', label: 'Checkerboard', description: 'Orange checks and diamonds' },
  { id: 'sunny-daisies', label: 'Daisies', description: 'Orange flowers on cream' },
  { id: 'midnight-diamonds', label: 'Diamonds', description: 'Cream diamonds on dark brown' },
] as const;
export type WallpaperId = typeof WALLPAPERS[number]['id'];
export function wallpaperId(value: unknown): WallpaperId | 'none' {
  return WALLPAPERS.some((wallpaper) => wallpaper.id === value)
    ? value as WallpaperId
    : 'none';
}
