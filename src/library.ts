import type { JsonObject } from '@aelionsdk/core';
import type { AelionProject } from '@aelionsdk/project-schema';

import { formatClock, safeText } from './format.js';
import { icon } from './icons.js';
import { libraryPreview } from './library-previews.js';
import { EFFECT_CATALOG, TRANSITION_CATALOG } from './project.js';
import type { LibrarySort, LibraryTab, LibraryView } from './view-state.js';

const RAIL: readonly { id: LibraryTab; label: string; glyph: Parameters<typeof icon>[0] }[] = [
  { id: 'media', label: '素材', glyph: 'folder' },
  { id: 'text', label: '文本', glyph: 'text' },
  { id: 'generate', label: '生成', glyph: 'smile' },
  { id: 'effects', label: '效果', glyph: 'wand' },
  { id: 'transitions', label: '转场', glyph: 'transition' },
  { id: 'captions', label: '字幕', glyph: 'captions' },
  { id: 'audio', label: '音频', glyph: 'music' },
];

function tile(
  kind: string,
  title: string,
  hint: string,
  options: { readonly thumb?: string; readonly audio?: boolean } = {},
): string {
  const preview = libraryPreview(kind);
  const media =
    options.audio === true
      ? `<span class="lib-tile-thumb is-audio">${icon('music', 20)}<em>Audio</em><small>${safeText(hint)}</small></span>`
      : options.thumb !== undefined
        ? `<span class="lib-tile-thumb"><img alt="" src="${safeText(options.thumb)}" draggable="false"></span>`
        : (preview ??
          `<span class="lib-tile-thumb"><em>${safeText(title.slice(0, 1))}</em></span>`);
  return `<button type="button" class="lib-tile" draggable="true" data-drop="${safeText(kind)}" title="双击添加到时间线，或拖到轨道上">
    ${media}
    <span class="lib-tile-name">${safeText(title)}</span>
  </button>`;
}

function assetName(asset: { readonly id: string; readonly name?: unknown }): string {
  return typeof asset.name === 'string' ? asset.name : asset.id;
}

function sortAssets<T extends { readonly id: string; readonly name?: unknown }>(
  assets: readonly T[],
  dir: LibrarySort,
): T[] {
  const copy = [...assets];
  copy.sort((a, b) => assetName(a).localeCompare(assetName(b), 'zh'));
  return dir === 'za' ? copy.reverse() : copy;
}

function durationHint(asset: JsonObject, fallback: string): string {
  const probe = asset.probeHint;
  if (probe !== null && typeof probe === 'object' && !Array.isArray(probe)) {
    const durationUs = (probe as JsonObject).durationUs;
    if (typeof durationUs === 'number') return formatClock(durationUs);
  }
  return fallback;
}

export function renderLibrary(options: {
  readonly root: HTMLElement;
  readonly project: AelionProject | null;
  readonly tab: LibraryTab;
  readonly view: LibraryView;
  readonly sort: LibrarySort;
  readonly thumbs: ReadonlyMap<string, string>;
}): void {
  const { root, project, tab, view, sort, thumbs } = options;
  const assets = project === null ? [] : Object.values(project.assets);
  let body = '';
  if (tab === 'media') {
    const media = sortAssets(
      assets.filter(asset => {
        const kind = (asset as JsonObject).kind;
        return kind === 'video' || kind === 'image' || kind === 'audio';
      }),
      sort,
    );
    body =
      media.length === 0
        ? `<p class="empty-copy">导入视频、图片或音频。双击添加到时间线。</p>`
        : media
            .map(asset => {
              const kindValue = (asset as JsonObject).kind;
              const kind = typeof kindValue === 'string' ? kindValue : 'media';
              const thumb = thumbs.get(asset.id);
              return tile(
                `asset:${asset.id}`,
                assetName(asset),
                durationHint(asset as JsonObject, kind),
                {
                  ...(kind === 'audio' ? { audio: true } : {}),
                  ...(thumb === undefined ? {} : { thumb }),
                },
              );
            })
            .join('');
  } else if (tab === 'audio') {
    const audio = sortAssets(
      assets.filter(asset => (asset as JsonObject).kind === 'audio'),
      sort,
    );
    body =
      audio.length === 0
        ? `<p class="empty-copy">导入音频，或从含音视频的文件中自动拆出 A 轨。</p>`
        : audio
            .map(asset =>
              tile(
                `asset:${asset.id}`,
                assetName(asset),
                durationHint(asset as JsonObject, '音频'),
                {
                  audio: true,
                },
              ),
            )
            .join('');
  } else if (tab === 'text') {
    body = [
      tile('text-title', '标题', '居中标题'),
      tile('text-subtitle', '副标题', '较小字号'),
      tile('shape-rect', '矩形', '色块'),
      tile('shape-ellipse', '椭圆', '形状'),
    ].join('');
  } else if (tab === 'captions') {
    body = `${tile('caption', '字幕条', '添加到字幕轨')}
      <div class="lib-actions">
        <button type="button" data-act="import-sub">导入 SRT / VTT</button>
        <button type="button" data-act="export-srt">导出 SRT</button>
        <button type="button" data-act="export-vtt">导出 VTT</button>
      </div>`;
  } else if (tab === 'effects') {
    body = EFFECT_CATALOG.map(entry =>
      tile(`effect:${entry.id}`, entry.name, '应用到所选片段，可调强度'),
    ).join('');
  } else if (tab === 'transitions') {
    body = TRANSITION_CATALOG.map(entry =>
      tile(`transition:${entry.id}`, entry.name, '放到两段接头'),
    ).join('');
  } else {
    body = [
      tile('matte-black', '黑色色块', '纯色'),
      tile('matte-white', '白色色块', '纯色'),
      tile('gradient', '线性渐变', 'Generator'),
      tile('adjustment', '调整图层', '作用于下层'),
    ].join('');
  }

  const current = RAIL.find(entry => entry.id === tab);
  root.innerHTML = `
    <nav class="lib-rail" aria-label="素材分类">
      ${RAIL.map(
        entry =>
          `<button type="button" class="${entry.id === tab ? 'on' : ''}" data-tab="${entry.id}" title="${entry.label}">${icon(entry.glyph)}</button>`,
      ).join('')}
    </nav>
    <div class="lib-main">
      <header class="lib-head">
        <strong>${current?.label ?? '素材'}</strong>
        <span class="lib-head-actions">
          <button type="button" data-act="lib-view" title="${view === 'grid' ? '列表' : '网格'}">${icon(view === 'grid' ? 'list' : 'grid')}</button>
          <button type="button" data-act="lib-sort" title="${sort === 'az' ? '按名称 Z-A' : '按名称 A-Z'}">${icon('sort')}</button>
          <button type="button" class="lib-import" data-cmd="import">${icon('import')}导入</button>
        </span>
      </header>
      <div class="lib-body is-${view}">${body}</div>
    </div>
  `;
}
