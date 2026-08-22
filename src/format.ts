const FRAME_US = 1_000_000;

export function clampTime(value: number, maxUs: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (maxUs <= 0) return 0;
  return Math.min(Math.max(0, rounded), Math.max(0, maxUs - 1));
}

export function frameDurationUs(frameRate: { numerator: number; denominator: number }): number {
  return Math.max(1, Math.round((FRAME_US * frameRate.denominator) / frameRate.numerator));
}

export function quantizeToFrame(
  timeUs: number,
  frameRate: { numerator: number; denominator: number },
): number {
  const frameUs = frameDurationUs(frameRate);
  return Math.max(0, Math.round(timeUs / frameUs) * frameUs);
}

export function formatTimecode(
  timeUs: number,
  frameRate: { numerator: number; denominator: number },
  dropFrames = false,
): string {
  const frameUs = frameDurationUs(frameRate);
  const totalFrames = Math.max(0, Math.floor(Math.max(0, timeUs) / frameUs));
  const fps = Math.max(1, Math.round(frameRate.numerator / frameRate.denominator));
  const frames = dropFrames ? totalFrames % fps : totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}

export function formatClock(timeUs: number, withMs = false): string {
  const clamped = Math.max(0, Math.round(timeUs));
  const totalMs = Math.floor(clamped / 1_000);
  const ms = totalMs % 1_000;
  const totalSeconds = Math.floor(totalMs / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const base = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}`;
  return withMs ? `${base}.${ms.toString().padStart(3, '0')}` : base;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDb(value: number): string {
  if (!Number.isFinite(value)) return '−∞';
  return `${value.toFixed(1)} dB`;
}

export function safeText(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
