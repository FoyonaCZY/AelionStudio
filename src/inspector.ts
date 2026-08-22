import type { JsonObject } from '@aelionsdk/core';
import type { AelionProject, ItemEntity, TransitionEntity } from '@aelionsdk/project-schema';

import { encodeHex, readLinearColor } from './color.js';
import { formatClock, formatTimecode, safeText } from './format.js';
import { icon } from './icons.js';
import {
  clipLabel,
  effectCatalogEntry,
  instanceMaterialId,
  itemAudio,
  transitionLabel,
  itemSource,
  itemVisual,
  numberField,
  readTransform,
  sequenceFormat,
  stringField,
} from './project.js';
import type { InspectorTab, ViewState } from './view-state.js';

function field(label: string, control: string): string {
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

function slider(name: string, min: number, max: number, step: number, value: number): string {
  return `<input data-bind="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${value}">
    <input data-bind="${name}" class="num" type="number" min="${min}" max="${max}" step="${step}" value="${value}">`;
}

function linearRate(item: ItemEntity): { rate: number; reverse: boolean } {
  const source = itemSource(item);
  const mapping = source?.timeMapping;
  if (mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping)) {
    const record = mapping as JsonObject;
    if (
      record.type === 'linear' &&
      typeof record.rate === 'object' &&
      record.rate !== null &&
      !Array.isArray(record.rate)
    ) {
      const rate = record.rate as JsonObject;
      const numerator = numberField(rate.numerator, 1);
      const denominator = numberField(rate.denominator, 1);
      return {
        rate: denominator === 0 ? 1 : numerator / denominator,
        reverse: record.reverse === true,
      };
    }
  }
  return { rate: 1, reverse: false };
}

function textOf(item: ItemEntity): string {
  if (item.type === 'caption') return stringField((item as JsonObject).text);
  const paragraphs = (item as JsonObject).paragraphs;
  if (!Array.isArray(paragraphs)) return '';
  const first = paragraphs[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return '';
  const runs = (first as JsonObject).runs;
  if (!Array.isArray(runs)) return '';
  return runs
    .map(run =>
      run !== null && typeof run === 'object' && !Array.isArray(run)
        ? stringField((run as JsonObject).text)
        : '',
    )
    .join('');
}

export function renderInspector(options: {
  readonly root: HTMLElement;
  readonly project: AelionProject | null;
  readonly item: ItemEntity | undefined;
  readonly transition?: TransitionEntity;
  readonly view: ViewState;
}): void {
  const { root, project, item, view } = options;
  if (options.transition !== undefined && project !== null) {
    renderTransitionInspector(root, project, options.transition);
    return;
  }
  if (item === undefined || project === null) {
    root.innerHTML = `<p class="empty-copy">在时间线上选择片段后，这里会显示变换、音频、变速和效果。</p>`;
    return;
  }
  const format = sequenceFormat(project);
  const visual = itemVisual(item);
  const audio = itemAudio(item);
  const transform = readTransform(item);
  const speed = linearRate(item);
  const tabs: InspectorTab[] = ['clip', 'video', 'audio', 'effect', 'speed'];
  const tabLabel: Record<InspectorTab, string> = {
    clip: '片段',
    video: '画面',
    audio: '音频',
    effect: '效果',
    speed: '变速',
  };
  let body = '';
  if (view.inspectorTab === 'clip') {
    body = `
      ${field('名称', `<strong>${safeText(clipLabel(item))}</strong>`)}
      ${field('类型', `<span>${safeText(item.type)}</span>`)}
      ${field('入点', `<span class="mono">${formatTimecode(item.range.startUs, format.frameRate)}</span>`)}
      ${field('时长', `<span class="mono">${formatClock(item.range.durationUs)}</span>`)}
      ${field('联动', `<span>${safeText(item.linkGroupId ?? '无')}</span>`)}
      ${item.type === 'text' || item.type === 'caption' ? field('文本', `<textarea data-bind="text" rows="4">${safeText(textOf(item))}</textarea>`) : ''}
      ${field('启用', `<input data-bind="enabled" type="checkbox"${item.enabled ? ' checked' : ''}>`)}
    `;
  } else if (view.inspectorTab === 'video') {
    if (visual === undefined) {
      body = `<p class="empty-copy">当前片段没有画面变换。</p>`;
    } else {
      body = `
        ${field('不透明度', slider('opacity', 0, 1, 0.01, numberField(visual.opacity, 1)))}
        ${field('缩放 X', slider('scaleX', 0.05, 4, 0.01, transform.scale.x))}
        ${field('缩放 Y', slider('scaleY', 0.05, 4, 0.01, transform.scale.y))}
        ${field('位置 X', slider('posX', -format.width, format.width * 2, 1, transform.positionPx.x))}
        ${field('位置 Y', slider('posY', -format.height, format.height * 2, 1, transform.positionPx.y))}
        ${field('旋转', slider('rotation', -180, 180, 0.1, transform.rotationDeg))}
        ${field(
          '适配',
          `<select data-bind="fit">
            ${(
              [
                ['contain', '适应'],
                ['cover', '铺满'],
                ['fill', '拉伸'],
                ['none', '原始'],
              ] as const
            )
              .map(
                ([value, label]) =>
                  `<option value="${value}"${visual.fit === value ? ' selected' : ''}>${label}</option>`,
              )
              .join('')}
          </select>`,
        )}
        ${field(
          '混合',
          `<select data-bind="blend">
            ${['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten']
              .map(
                value =>
                  `<option value="${value}"${visual.blendMode === value ? ' selected' : ''}>${value}</option>`,
              )
              .join('')}
          </select>`,
        )}
      `;
    }
  } else if (view.inspectorTab === 'audio') {
    if (audio === undefined) {
      body = `<p class="empty-copy">当前片段没有音频混合器。</p>`;
    } else {
      body = `
        ${field('增益', slider('gainDb', -24, 12, 0.1, numberField(audio.gainDb, 0)))}
        ${field('声像', slider('pan', -1, 1, 0.01, numberField(audio.pan, 0)))}
        ${field('淡入 ms', slider('fadeInMs', 0, 5000, 10, numberField(audio.fadeInUs, 0) / 1000))}
        ${field('淡出 ms', slider('fadeOutMs', 0, 5000, 10, numberField(audio.fadeOutUs, 0) / 1000))}
        ${field(
          '音高',
          `<select data-bind="pitch">
            <option value="varispeed"${audio.pitchPolicy === 'preserve' ? '' : ' selected'}>变速变调</option>
            <option value="preserve"${audio.pitchPolicy === 'preserve' ? ' selected' : ''}>保持音高</option>
          </select>`,
        )}
        <div class="row-actions">
          <button type="button" data-act="loudness">响度分析</button>
          <button type="button" data-act="silence">检测静音</button>
          <button type="button" data-act="remove-silence">移除静音</button>
          <button type="button" data-act="beats">节拍标记</button>
          <button type="button" data-act="energy">能量切点</button>
        </div>
      `;
    }
  } else if (view.inspectorTab === 'effect') {
    const cards = item.materialInstanceIds.flatMap(id => {
      const instance = project.materialInstances[id] as JsonObject | undefined;
      if (instance === undefined) return [];
      return [effectCard(id, instance)];
    });
    body = `
      <p class="empty-copy">从左侧「效果」双击或拖到选中片段上。同一种效果只会保留一份。</p>
      ${cards.length > 0 ? cards.join('') : '<p class="empty-copy">未应用效果</p>'}
    `;
  } else {
    const source = itemSource(item);
    body =
      source === undefined
        ? `<p class="empty-copy">生成器 / 文字片段没有素材时间映射。</p>`
        : `
        ${field('速率', slider('rate', 0.1, 4, 0.05, speed.rate))}
        ${field('倒放', `<input data-bind="reverse" type="checkbox"${speed.reverse ? ' checked' : ''}>`)}
        <div class="row-actions">
          <button type="button" data-act="freeze">在出点定格 2 秒</button>
        </div>
      `;
  }

  const shape = (item as JsonObject).shape;
  const fill =
    shape !== null && typeof shape === 'object' && !Array.isArray(shape)
      ? encodeHex(readLinearColor((shape as JsonObject).fill), '#3d8bfd')
      : undefined;

  root.innerHTML = `
    <div class="insp-tabs">
      ${tabs
        .map(
          tab =>
            `<button type="button" class="${tab === view.inspectorTab ? 'on' : ''}" data-tab="${tab}">${tabLabel[tab]}</button>`,
        )
        .join('')}
    </div>
    <div class="insp-body">${body}${
      fill === undefined
        ? ''
        : field('填充', `<input data-bind="fill" type="color" value="${fill}">`)
    }</div>
  `;
}

function effectCard(instanceId: string, instance: JsonObject): string {
  const materialId = instanceMaterialId(instance);
  const catalog = materialId === undefined ? undefined : effectCatalogEntry(materialId);
  const rawName = instance.name;
  const name =
    catalog?.name ?? (typeof rawName === 'string' && rawName.length > 0 ? rawName : '效果');
  const parameters =
    instance.parameters !== null &&
    typeof instance.parameters === 'object' &&
    !Array.isArray(instance.parameters)
      ? (instance.parameters as JsonObject)
      : {};
  const value = numberField(parameters.value, catalog?.value ?? 100);
  const min = catalog?.min ?? 0;
  const max = catalog?.max ?? 200;
  const step = catalog?.step ?? 1;
  const label = catalog?.label ?? '强度';
  return `<article class="effect-card">
    <header>
      <strong>${safeText(name)}</strong>
      <button type="button" class="icon-btn" data-act="remove-effect" data-effect="${safeText(instanceId)}" title="删除效果" aria-label="删除效果">${icon('trash', 14)}</button>
    </header>
    ${field(
      label,
      `<input data-bind="effect-value" data-effect="${safeText(instanceId)}" type="range" min="${min.toString()}" max="${max.toString()}" step="${step.toString()}" value="${value.toString()}">
      <input data-bind="effect-value" data-effect="${safeText(instanceId)}" class="num" type="number" min="${min.toString()}" max="${max.toString()}" step="${step.toString()}" value="${value.toString()}">`,
    )}
  </article>`;
}

function renderTransitionInspector(
  root: HTMLElement,
  project: AelionProject,
  transition: TransitionEntity,
): void {
  const from = project.items[transition.fromItemId];
  const to = project.items[transition.toItemId];
  const seconds = transition.range.durationUs / 1_000_000;
  root.innerHTML = `
    <div class="insp-tabs">
      <button type="button" class="on">转场</button>
    </div>
    <div class="insp-body">
      ${field('名称', `<strong>${safeText(transitionLabel(project, transition))}</strong>`)}
      ${field('时长', slider('transition-duration', 0.2, 5, 0.05, Number(seconds.toFixed(2))))}
      ${field('出点', `<span>${safeText(from === undefined ? transition.fromItemId : clipLabel(from))}</span>`)}
      ${field('入点', `<span>${safeText(to === undefined ? transition.toItemId : clipLabel(to))}</span>`)}
      <p class="empty-copy">转场叠在两段接头上。拖两边可改时长，删除只去掉转场。</p>
      <div class="row-actions">
        <button type="button" data-act="delete-transition">删除转场</button>
      </div>
    </div>
  `;
}
