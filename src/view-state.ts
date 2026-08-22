import type { PreviewCanvasQuality } from '@aelionsdk/sdk';

export type EditTool = 'select' | 'razor' | 'slip' | 'slide' | 'roll';
export type LibraryTab =
  | 'media'
  | 'audio'
  | 'text'
  | 'captions'
  | 'effects'
  | 'transitions'
  | 'generate';
export type LibraryView = 'grid' | 'list';
export type LibrarySort = 'az' | 'za';
export type InspectorTab = 'clip' | 'video' | 'audio' | 'effect' | 'speed';

export interface ViewState {
  selectedItemId: string | undefined;
  selectedTransitionId: string | undefined;
  selectedTrackId: string | undefined;
  tool: EditTool;
  currentTimeUs: number;
  pixelsPerSecond: number;
  scrollLeftPx: number;
  snap: boolean;
  linkedEdit: boolean;
  ripple: boolean;
  libraryTab: LibraryTab;
  libraryView: LibraryView;
  librarySort: LibrarySort;
  inspectorTab: InspectorTab;
  previewQuality: PreviewCanvasQuality;
  showSafeArea: boolean;
  leftWidth: number;
  rightWidth: number;
  timelineHeight: number;
  status: string;
  error: boolean;
  busy: string | undefined;
  exportProgress: number | undefined;
  analysisText: string | undefined;
}

export function createViewState(): ViewState {
  return {
    selectedItemId: undefined,
    selectedTransitionId: undefined,
    selectedTrackId: undefined,
    tool: 'select',
    currentTimeUs: 0,
    pixelsPerSecond: 90,
    scrollLeftPx: 0,
    snap: true,
    linkedEdit: true,
    ripple: false,
    libraryTab: 'media',
    libraryView: 'grid',
    librarySort: 'az',
    inspectorTab: 'clip',
    previewQuality: 'adaptive',
    showSafeArea: false,
    leftWidth: 312,
    rightWidth: 280,
    timelineHeight: 268,
    status: '空时间线 · 导入素材或添加标题开始剪辑',
    error: false,
    busy: undefined,
    exportProgress: undefined,
    analysisText: undefined,
  };
}

export function resetViewState(view: ViewState): void {
  view.selectedItemId = undefined;
  view.selectedTransitionId = undefined;
  view.selectedTrackId = undefined;
  view.tool = 'select';
  view.currentTimeUs = 0;
  view.pixelsPerSecond = 90;
  view.scrollLeftPx = 0;
  view.analysisText = undefined;
  view.exportProgress = undefined;
  view.busy = undefined;
  view.error = false;
}

export const TRACK_HEADER_WIDTH = 108;
export const RULER_HEIGHT = 22;
export const SNAP_PIXELS = 8;
export const MIN_TIMELINE_US = 10_000_000;
