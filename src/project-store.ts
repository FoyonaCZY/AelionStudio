import type { JsonObject } from '@aelionsdk/core';

export const STUDIO_DB = 'aelion-studio';
export const STUDIO_REVISION_STORE = 'project-revisions';

export interface ProjectSummary {
  readonly id: string;
  readonly title: string;
  readonly modifiedAtMs: number;
  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
}

export function newProjectId(): string {
  return `proj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  const records = await readAllRecords();
  const summaries = records.flatMap(record => {
    const summary = summarizeRecord(record);
    return summary === undefined ? [] : [summary];
  });
  summaries.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  return summaries;
}

function openStudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STUDIO_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STUDIO_REVISION_STORE)) {
        request.result.createObjectStore(STUDIO_REVISION_STORE, { keyPath: 'projectId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开工程库'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('工程库事务已中止', 'AbortError'));
    transaction.onerror = () => reject(transaction.error ?? new Error('工程库事务失败'));
  });
}

async function readAllRecords(): Promise<readonly Record<string, unknown>[]> {
  const database = await openStudioDb();
  try {
    if (!database.objectStoreNames.contains(STUDIO_REVISION_STORE)) return [];
    const transaction = database.transaction(STUDIO_REVISION_STORE, 'readonly');
    const request = transaction.objectStore(STUDIO_REVISION_STORE).getAll();
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('读取工程列表失败'));
    });
    await transactionDone(transaction);
    return rows.filter(
      row => row !== null && typeof row === 'object' && !Array.isArray(row),
    ) as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

function summarizeRecord(record: Record<string, unknown>): ProjectSummary | undefined {
  if (typeof record.projectId !== 'string' || typeof record.canonicalProject !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(record.canonicalProject);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const project = parsed as JsonObject;
    const metadata =
      project.metadata !== null &&
      typeof project.metadata === 'object' &&
      !Array.isArray(project.metadata)
        ? (project.metadata as JsonObject)
        : {};
    const title =
      typeof metadata.title === 'string' && metadata.title.length > 0
        ? metadata.title
        : '未命名工程';
    const durationUs = durationFromProject(project);
    const sequences =
      project.sequences !== null &&
      typeof project.sequences === 'object' &&
      !Array.isArray(project.sequences)
        ? (project.sequences as Record<string, JsonObject>)
        : {};
    const settings =
      project.settings !== null &&
      typeof project.settings === 'object' &&
      !Array.isArray(project.settings)
        ? (project.settings as JsonObject)
        : {};
    const defaultId =
      typeof settings.defaultSequenceId === 'string' ? settings.defaultSequenceId : '';
    const sequence = Object.hasOwn(sequences, defaultId)
      ? sequences[defaultId]
      : Object.values(sequences)[0];
    const rawFormat = sequence === undefined ? undefined : sequence.format;
    const format =
      rawFormat !== null && typeof rawFormat === 'object' && !Array.isArray(rawFormat)
        ? (rawFormat as JsonObject)
        : {};
    return {
      id: record.projectId,
      title,
      modifiedAtMs: typeof record.savedAtEpochMs === 'number' ? record.savedAtEpochMs : Date.now(),
      durationUs,
      width: typeof format.width === 'number' ? format.width : 1920,
      height: typeof format.height === 'number' ? format.height : 1080,
    };
  } catch {
    return undefined;
  }
}

function durationFromProject(project: JsonObject): number {
  const items = project.items;
  if (items === null || typeof items !== 'object' || Array.isArray(items)) return 0;
  let maxUs = 0;
  for (const value of Object.values(items as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const range = (value as JsonObject).range;
    if (range === null || typeof range !== 'object' || Array.isArray(range)) continue;
    const startUs = (range as JsonObject).startUs;
    const durationUs = (range as JsonObject).durationUs;
    if (typeof startUs === 'number' && typeof durationUs === 'number') {
      maxUs = Math.max(maxUs, startUs + durationUs);
    }
  }
  return maxUs;
}
