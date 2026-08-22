import type { AelionProject } from '@aelionsdk/project-schema';

const ENTITY_ID = /^[A-Za-z][A-Za-z0-9._:-]*$/u;

export class IdFactory {
  #n = 0;

  public reset(): void {
    this.#n = 0;
  }

  public observe(project: AelionProject | null): void {
    if (project === null) return;
    for (const id of [
      ...Object.keys(project.assets),
      ...Object.keys(project.sequences),
      ...Object.keys(project.tracks),
      ...Object.keys(project.items),
      ...Object.keys(project.materialInstances),
      ...Object.keys(project.transitions),
      ...Object.keys(project.markers),
      ...Object.keys(project.linkGroups),
    ]) {
      const match = /(?:^|_)(\d+)$/u.exec(id);
      if (match?.[1] !== undefined) this.#n = Math.max(this.#n, Number(match[1]));
    }
  }

  public next(prefix: string): string {
    for (;;) {
      this.#n += 1;
      const candidate = `${prefix}_${this.#n.toString()}`;
      if (ENTITY_ID.test(candidate)) return candidate;
    }
  }
}

export function isEntityId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && ENTITY_ID.test(value);
}
