export interface ParsedCue {
  readonly startUs: number;
  readonly endUs: number;
  readonly text: string;
}

function parseStamp(value: string): number {
  const match = /(\d+):(\d+):(\d+)[,.](\d+)/u.exec(value.trim());
  if (match === null) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fraction = match[4] ?? '0';
  const ms = Number(fraction.padEnd(3, '0').slice(0, 3));
  return ((hours * 3600 + minutes * 60 + seconds) * 1000 + ms) * 1000;
}

export function parseSubtitleDocument(text: string): readonly ParsedCue[] {
  const normalized = text.replaceAll('\r\n', '\n').replace(/^WEBVTT.*\n+/u, '');
  const blocks = normalized.split(/\n\n+/u);
  const cues: ParsedCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(line => line.length > 0 && !/^\d+$/u.test(line));
    const time = lines.find(line => line.includes('-->'));
    if (time === undefined) continue;
    const [start, end] = time.split('-->');
    if (start === undefined || end === undefined) continue;
    const startUs = parseStamp(start);
    const endUs = parseStamp(end.replace(/ [A-Za-z].*$/u, ''));
    const body = lines
      .filter(line => line !== time)
      .join('\n')
      .trim();
    if (body.length === 0 || endUs <= startUs) continue;
    cues.push({ startUs, endUs, text: body });
  }
  return cues;
}
