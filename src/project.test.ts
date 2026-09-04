import { describe, expect, it } from 'vitest';

import { createEmptyProject, primaryVisualTrackId } from './project.js';

const options = {
  projectId: 'project_test',
  sequenceId: 'sequence_main',
  title: 'Test project',
  sequenceName: 'Main',
  width: 1920,
  height: 1080,
  frameRate: { numerator: 30, denominator: 1 },
} as const;

describe('AelionSDK 2.0 project model', () => {
  it('creates a v2 project with one explicit storyline', () => {
    const project = structuredClone(createEmptyProject(options));

    expect(project.$schema).toBe('https://schemas.aelion.dev/project/v2.0.json');
    expect(project.schemaVersion).toBe('2.0.0');
    expect(project.tracks.track_v1?.role).toBe('storyline');
    expect(project.tracks.track_v1?.occupancy).toBe('exclusive');
    expect(project.tracks.track_v2?.role).toBe('overlay');
    expect(project.tracks.track_a1?.role).toBe('overlay');
    expect(primaryVisualTrackId(project)).toBe('track_v1');
  });

  it('honours a declared storyline before the legacy first-visual fallback', () => {
    const project = structuredClone(createEmptyProject(options));
    const first = project.tracks.track_v1;
    const second = project.tracks.track_v2;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    delete first.role;
    second.role = 'storyline';

    expect(primaryVisualTrackId(project)).toBe('track_v2');
  });
});
