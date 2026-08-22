export function icon(name: IconName, size = 16): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="${size.toString()}" height="${size.toString()}" aria-hidden="true">${ICONS[name]}</svg>`;
}

export type IconName = keyof typeof ICONS;

const ICONS = {
  folder: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M2.2 4.2h4.1l1.2 1.4h6.3v7.2H2.2z"/>`,
  text: `<path fill="currentColor" d="M4 3.2h8v1.5H8.9v8.1H7.1V4.7H4z"/>`,
  smile: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 2.4a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 0 1 0-11.2z"/><path fill="none" stroke="currentColor" stroke-width="1.3" d="M5.4 9c.7 1 1.6 1.5 2.6 1.5S9.9 10 10.6 9"/><circle cx="6" cy="6.6" r=".8" fill="currentColor"/><circle cx="10" cy="6.6" r=".8" fill="currentColor"/>`,
  wand: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="m3.2 12.8 6.2-6.2M10.6 3.1l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/>`,
  transition: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M3 5.2h6.2L7.4 3.4M13 10.8H6.8l1.8 1.8"/>`,
  captions: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.4 3.6h11.2v8.8H2.4z"/><path fill="currentColor" d="M4.2 6.2h2.1v1.2H4.2zm3.4 0h4.2v1.2H7.6zM4.2 8.6h4.4v1.2H4.2zm5.4 0h2.2v1.2H9.6z"/>`,
  sliders: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M3 3.2v9.6M8 3.2v9.6M13 3.2v9.6M3 6.2h2.4M8 10.2h2.4M13 5.4H15"/>`,
  music: `<path fill="currentColor" d="M6.2 12.4a1.8 1.8 0 1 1 0-3.6c.3 0 .6.1.8.2V4.1l6.2-1.3v7.8a1.8 1.8 0 1 1-1.5-1.8V5.2L7.7 6.2v4.4a1.8 1.8 0 0 1-1.5 1.8z"/>`,
  import: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 3.2v6.4M5.6 6.8 8 9.2l2.4-2.4M3.2 12.4h9.6"/>`,
  list: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M3 4.2h10M3 8h10M3 11.8h10"/>`,
  grid: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M3 3h4.2v4.2H3zm5.8 0H13v4.2H8.8zM3 8.8h4.2V13H3zm5.8 0H13V13H8.8z"/>`,
  sort: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M4.2 3.4v9.2M4.2 3.4 2.6 5.2M4.2 12.6l1.6-1.8M8 4.2h5.2M8 8h3.8M8 11.8h2.4"/>`,
  cursor: `<path fill="currentColor" d="M4.2 2.3 12.7 9.2l-3.7.2 2.5 4.8-1.9.9-2.5-4.8-2.5 2.5z"/>`,
  scissors: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M4.2 4.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zm0 4.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM5.6 6.8 13 3.6M5.6 9.2 13 12.4"/>`,
  slip: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M4.4 4.4h7.2v7.2H4.4zM3 8h10M3 8l1.4-1.4M3 8l1.4 1.4M13 8l-1.4-1.4M13 8l-1.4 1.4"/>`,
  slide: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M5.2 4.6h5.6v6.8H5.2zM2.2 8h2.2M11.6 8h2.2M2.2 8l1.3-1.3M2.2 8l1.3 1.3M13.8 8l-1.3-1.3M13.8 8l-1.3 1.3"/>`,
  roll: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.2 4.4h5.4v7.2H2.2zM8.4 4.4h5.4v7.2H8.4zM5.6 8h4.8M5.6 8l1.2-1.2M5.6 8l1.2 1.2M10.4 8l-1.2-1.2M10.4 8l-1.2 1.2"/>`,
  magnet: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M4 3v5.2a4 4 0 0 0 8 0V3M4 3h2.5v5.2a1.5 1.5 0 1 0 3 0V3H12"/>`,
  ripple: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.4 4.8h4.6v6.4H2.4zM8.2 8h5.4M11.4 5.8 13.8 8l-2.4 2.2"/>`,
  safe: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.8 3.2h10.4v9.6H2.8zM5 5.2h6v5.6H5z"/>`,
  minus: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M3.4 8h9.2"/>`,
  link: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M6.4 9.6 9.6 6.4m-4.7 4.7 1.5 1.5a2.2 2.2 0 0 0 3.1 0l1.2-1.2m1.2-4.3-1.5-1.5a2.2 2.2 0 0 0-3.1 0L6.1 6.8"/>`,
  copy: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M5.2 5.2h7.4v8.2H5.2zM3.4 10.8V2.6h7.2"/>`,
  snow: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M8 2.6v10.8M3.8 5.2 12.2 10.8M3.8 10.8 12.2 5.2"/>`,
  trash: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M3.4 4.6h9.2M6 4.6V3.2h4v1.4M4.6 4.6l.6 8.2h5.6l.6-8.2"/>`,
  marker: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M4.2 13.2V5.4l3.8-2.6 3.8 2.6v7.8z"/>`,
  curve: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.6 12.2c2.4-7.2 8.4-7.2 10.8 0"/><circle cx="4.2" cy="8.6" r="1" fill="currentColor"/><circle cx="11.8" cy="8.6" r="1" fill="currentColor"/>`,
  eye: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M1.8 8s2.2-4.2 6.2-4.2S14.2 8 14.2 8s-2.2 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>`,
  speaker: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M3.2 6.2h2.2L8.4 4v8L5.4 9.8H3.2zM10.4 6.4a2.4 2.4 0 0 1 0 3.2"/>`,
  camera: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.4 5.2h4.1l1.1-1.4h3.8v8.6H2.4z"/><circle cx="8" cy="8.4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/>`,
  lock: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M5 7.4V5.6a3 3 0 0 1 6 0v1.8M4.2 7.4h7.6v5.6H4.2z"/>`,
  plus: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M8 3.4v9.2M3.4 8h9.2"/>`,
  search: `<path fill="none" stroke="currentColor" stroke-width="1.4" d="M7 3.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6zM10.2 10.2 13 13"/>`,
  calendar: `<path fill="none" stroke="currentColor" stroke-width="1.3" d="M3.2 4.2h9.6v9.2H3.2zM3.2 7.2h9.6M6 3.2v2M10 3.2v2"/>`,
} as const;
