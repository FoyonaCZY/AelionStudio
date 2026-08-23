function frame(fill: string, inner: string): string {
  return `<rect width="96" height="54" rx="0" fill="${fill}"/>${inner}`;
}

function svg(inner: string, tone = ''): string {
  const cls = tone.length === 0 ? 'lib-tile-thumb is-preview' : `lib-tile-thumb is-preview ${tone}`;
  return `<span class="${cls}"><svg viewBox="0 0 96 54" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${inner}</svg></span>`;
}

const PREVIEWS: Readonly<Record<string, string>> = {
  'text-title': svg(
    frame(
      '#1c1912',
      `<text x="48" y="34" text-anchor="middle" fill="#f4f0e6" font-size="20" font-weight="700" font-family="Segoe UI, Microsoft YaHei, sans-serif">标题</text>`,
    ),
    'is-text',
  ),
  'text-subtitle': svg(
    frame(
      '#1a1a1a',
      `<text x="48" y="28" text-anchor="middle" fill="#d8d8d8" font-size="12" font-weight="600" font-family="Segoe UI, Microsoft YaHei, sans-serif">副标题</text>
       <rect x="30" y="36" width="36" height="2" rx="1" fill="#8a8a8a"/>`,
    ),
    'is-text',
  ),
  'shape-rect': svg(
    frame('#16141c', `<rect x="22" y="12" width="52" height="30" rx="5" fill="#3d8bfd"/>`),
    'is-shape',
  ),
  'shape-ellipse': svg(
    frame('#16141c', `<ellipse cx="48" cy="27" rx="24" ry="15" fill="#5c4480"/>`),
    'is-shape',
  ),
  caption: svg(
    frame(
      '#141414',
      `<rect x="8" y="8" width="80" height="38" rx="3" fill="#1c1c1c" stroke="#333"/>
       <rect x="18" y="34" width="60" height="8" rx="2" fill="#8a5528"/>
       <rect x="24" y="36.5" width="36" height="3" rx="1" fill="#f0d2b0"/>`,
    ),
    'is-caption',
  ),
  'matte-black': svg(frame('#0a0a0a', `<rect x="10" y="8" width="76" height="38" rx="4" fill="#111"/>`)),
  'matte-white': svg(
    frame('#2a2a2a', `<rect x="10" y="8" width="76" height="38" rx="4" fill="#f3f3f3"/>`),
  ),
  gradient: svg(
    `<defs><linearGradient id="lib-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a1a1a"/><stop offset="1" stop-color="#3d8bfd"/></linearGradient></defs>
     <rect width="96" height="54" fill="url(#lib-grad)"/>`,
  ),
  adjustment: svg(
    frame(
      '#1b1b1b',
      `<path d="M28 12v30M48 12v30M68 12v30" fill="none" stroke="#8d8d8d" stroke-width="2"/>
       <circle cx="28" cy="22" r="3.5" fill="#3d8bfd"/>
       <circle cx="48" cy="34" r="3.5" fill="#3d8bfd"/>
       <circle cx="68" cy="18" r="3.5" fill="#3d8bfd"/>`,
    ),
    'is-adjust',
  ),
  'diffusion-brightness': svg(
    frame(
      '#2a2414',
      `<circle cx="48" cy="27" r="9" fill="#f0c14a"/>
       <g stroke="#f0c14a" stroke-width="2" stroke-linecap="round">
         <path d="M48 8v6M48 40v6M28 27h6M62 27h6M33 12l4 4M59 38l4 4M33 42l4-4M59 16l4-4"/>
       </g>`,
    ),
  ),
  'diffusion-contrast': svg(
    `<rect width="48" height="54" fill="#0d0d0d"/><rect x="48" width="48" height="54" fill="#e8e8e8"/>
     <circle cx="36" cy="27" r="10" fill="#3a3a3a"/><circle cx="60" cy="27" r="10" fill="#c8c8c8"/>`,
  ),
  'diffusion-saturate': svg(
    frame(
      '#161616',
      `<circle cx="30" cy="27" r="8" fill="#e24b3b"/><circle cx="48" cy="27" r="8" fill="#3d8bfd"/><circle cx="66" cy="27" r="8" fill="#3fa66c"/>`,
    ),
  ),
  'diffusion-grayscale': svg(
    frame(
      '#1a1a1a',
      `<rect x="14" y="12" width="16" height="30" fill="#d0d0d0"/><rect x="32" y="12" width="16" height="30" fill="#8d8d8d"/><rect x="50" y="12" width="16" height="30" fill="#4a4a4a"/><rect x="68" y="12" width="14" height="30" fill="#2a2a2a"/>`,
    ),
  ),
  'diffusion-sepia': svg(
    frame(
      '#2a2016',
      `<rect x="18" y="12" width="60" height="30" rx="4" fill="#c4a06a"/>
       <rect x="26" y="20" width="20" height="14" fill="#8a6a22"/>
       <circle cx="62" cy="22" r="6" fill="#f0c14a"/>`,
    ),
  ),
  'diffusion-hue-rotate': svg(
    `<defs><linearGradient id="lib-hue" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e24b3b"/><stop offset=".25" stop-color="#f0c14a"/><stop offset=".5" stop-color="#3fa66c"/><stop offset=".75" stop-color="#3d8bfd"/><stop offset="1" stop-color="#7c5ea8"/>
    </linearGradient></defs>
    <rect width="96" height="54" fill="#141414"/>
    <rect x="10" y="16" width="76" height="22" rx="11" fill="url(#lib-hue)"/>`,
  ),
  'diffusion-invert': svg(
    `<rect width="48" height="54" fill="#111"/><rect x="48" width="48" height="54" fill="#eee"/>
     <rect x="22" y="16" width="20" height="22" fill="#eee"/><rect x="54" y="16" width="20" height="22" fill="#111"/>`,
  ),
  'diffusion-blur': svg(
    frame(
      '#161820',
      `<circle cx="36" cy="27" r="12" fill="#3d8bfd" opacity=".35"/><circle cx="48" cy="27" r="12" fill="#3d8bfd" opacity=".55"/><circle cx="60" cy="27" r="12" fill="#5aa2ff" opacity=".8"/>`,
    ),
  ),
  'diffusion-dissolve': svg(
    frame(
      '#141414',
      `<rect x="8" y="10" width="50" height="34" rx="4" fill="#2c5d8a"/>
       <rect x="38" y="10" width="50" height="34" rx="4" fill="#c47a2a" opacity=".7"/>`,
    ),
    'is-transition',
  ),
  'diffusion-slide-from-right': svg(
    frame(
      '#141414',
      `<rect x="6" y="10" width="40" height="34" rx="3" fill="#2c5d8a"/>
       <rect x="40" y="10" width="50" height="34" rx="3" fill="#3d8bfd"/>
       <path d="M62 27h16M70 20l8 7-8 7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
    'is-transition',
  ),
  'diffusion-slide-from-left': svg(
    frame(
      '#141414',
      `<rect x="50" y="10" width="40" height="34" rx="3" fill="#2c5d8a"/>
       <rect x="6" y="10" width="50" height="34" rx="3" fill="#3d8bfd"/>
       <path d="M34 27H18M26 20l-8 7 8 7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
    'is-transition',
  ),
  'diffusion-fade-to-black': svg(
    `<defs><linearGradient id="lib-fade-k" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2c5d8a"/><stop offset="1" stop-color="#050505"/></linearGradient></defs>
     <rect width="96" height="54" fill="url(#lib-fade-k)"/>
     <circle cx="30" cy="20" r="6" fill="#f0c14a"/>`,
    'is-transition',
  ),
  'diffusion-fade-to-white': svg(
    `<defs><linearGradient id="lib-fade-w" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2c5d8a"/><stop offset="1" stop-color="#f5f5f5"/></linearGradient></defs>
     <rect width="96" height="54" fill="url(#lib-fade-w)"/>
     <circle cx="30" cy="20" r="6" fill="#f0c14a"/>`,
    'is-transition',
  ),
};

export function libraryPreview(kind: string): string | undefined {
  if (kind.startsWith('effect:')) return PREVIEWS[kind.slice(7)];
  if (kind.startsWith('transition:')) return PREVIEWS[kind.slice(11)];
  return PREVIEWS[kind];
}
