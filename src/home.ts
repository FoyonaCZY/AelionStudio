import { safeText } from './format.js';
import { icon } from './icons.js';
import type { ProjectSummary } from './project-store.js';

export type HomeViewMode = 'grid' | 'list';
export type HomeSort = 'modified' | 'title';

export interface HomeState {
  query: string;
  view: HomeViewMode;
  sort: HomeSort;
}

export type StudioRoute =
  | { readonly screen: 'home' }
  | { readonly screen: 'editor'; readonly projectId: string };

export const HOME_HASH = '#/projects';

export function createHomeState(): HomeState {
  return { query: '', view: 'grid', sort: 'modified' };
}

export function editorHash(projectId: string): string {
  return `#/edit/${encodeURIComponent(projectId)}`;
}

export function parseStudioRoute(hash = location.hash): StudioRoute {
  const match = /^#\/edit\/([^/]+)$/u.exec(hash);
  if (match?.[1] !== undefined) {
    return { screen: 'editor', projectId: decodeURIComponent(match[1]) };
  }
  return { screen: 'home' };
}

export function renderHome(options: {
  readonly root: HTMLElement;
  readonly count: HTMLElement;
  readonly projects: readonly ProjectSummary[];
  readonly state: HomeState;
}): void {
  const visible = visibleProjects(options.projects, options.state);
  options.count.textContent =
    options.state.query.trim().length === 0
      ? `${options.projects.length.toString()} 个项目`
      : `${visible.length.toString()} / ${options.projects.length.toString()} 个项目`;
  options.root.classList.toggle('is-list', options.state.view === 'list');
  if (options.projects.length === 0) {
    options.root.innerHTML = '<p class="home-empty">还没有工程。点击「新建项目」开始剪辑。</p>';
    return;
  }
  if (visible.length === 0) {
    options.root.innerHTML = '<p class="home-empty">没有匹配的项目。</p>';
    return;
  }
  options.root.innerHTML = visible.map(projectCard).join('');
}

function visibleProjects(projects: readonly ProjectSummary[], state: HomeState): ProjectSummary[] {
  const query = state.query.trim().toLowerCase();
  const filtered =
    query.length === 0
      ? [...projects]
      : projects.filter(project => project.title.toLowerCase().includes(query));
  if (state.sort === 'title') {
    filtered.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
  }
  return filtered;
}

function projectCard(project: ProjectSummary): string {
  const letter = initialLetter(project.title);
  return `<article class="project-card">
  <button type="button" class="project-open" data-open-project="${safeText(project.id)}">
    <div class="project-thumb">
      <span class="project-letter">${safeText(letter)}</span>
      <span class="project-dur">${safeText(formatProjectDuration(project.durationUs))}</span>
    </div>
    <div class="project-meta">
      <h3>${safeText(project.title)}</h3>
      <p>${icon('calendar', 12)}<span>修改于 ${safeText(formatModified(project.modifiedAtMs))}</span></p>
    </div>
  </button>
  <button type="button" class="project-delete" data-delete-project="${safeText(project.id)}" title="删除工程" aria-label="删除工程">
    ${icon('trash', 14)}
  </button>
</article>`;
}

function formatProjectDuration(us: number): string {
  const totalSeconds = Math.floor(Math.max(0, us) / 1_000_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function initialLetter(title: string): string {
  for (const part of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(title)) {
    return part.segment;
  }
  return '项';
}

function formatModified(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}
