export interface ContextMenuAction {
  readonly kind: 'action';
  readonly id: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly danger?: boolean;
}

export interface ContextMenuSeparator {
  readonly kind: 'separator';
}

export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator;

export interface ContextTarget {
  readonly kind:
    | 'home-project'
    | 'home'
    | 'library-tile'
    | 'library'
    | 'clip'
    | 'transition'
    | 'marker'
    | 'track'
    | 'timeline'
    | 'monitor'
    | 'inspector-effect'
    | 'inspector'
    | 'dialog'
    | 'app';
  readonly projectId?: string;
  readonly itemId?: string;
  readonly transitionId?: string;
  readonly markerId?: string;
  readonly trackId?: string;
  readonly drop?: string;
  readonly effectId?: string;
  readonly timeUs?: number;
}

const HOST_ID = 'ctx-menu';

let onSelect: ((id: string) => void) | undefined;

export function allowsNativeContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function isContextMenuElement(target: EventTarget | null): boolean {
  return target instanceof Node && host()?.contains(target) === true;
}

export function hideContextMenu(): void {
  const menu = host();
  if (menu === undefined) return;
  menu.hidden = true;
  menu.replaceChildren();
  onSelect = undefined;
}

export function showContextMenu(options: {
  readonly items: readonly ContextMenuEntry[];
  readonly x: number;
  readonly y: number;
  readonly onSelect: (id: string) => void;
}): void {
  const items = visibleEntries(options.items);
  if (items.length === 0) return;
  const menu = ensureHost();
  onSelect = options.onSelect;
  menu.replaceChildren();
  for (const entry of items) {
    if (entry.kind === 'separator') {
      menu.append(document.createElement('hr'));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitem';
    button.dataset.id = entry.id;
    button.textContent = entry.label;
    if (entry.shortcut !== undefined) {
      const kbd = document.createElement('kbd');
      kbd.textContent = entry.shortcut;
      button.append(kbd);
      button.setAttribute('aria-label', `${entry.label} ${entry.shortcut}`);
    }
    if (entry.disabled === true) button.disabled = true;
    if (entry.checked === true) button.dataset.checked = 'true';
    if (entry.danger === true) button.classList.add('danger');
    menu.append(button);
  }
  menu.hidden = false;
  menu.style.left = `${options.x}px`;
  menu.style.top = `${options.y}px`;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(options.x, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(options.y, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function item(
  id: string,
  label: string,
  extras: Omit<ContextMenuAction, 'kind' | 'id' | 'label'> = {},
): ContextMenuAction {
  return {
    kind: 'action',
    id,
    label,
    ...(extras.shortcut === undefined ? {} : { shortcut: extras.shortcut }),
    ...(extras.disabled === undefined ? {} : { disabled: extras.disabled }),
    ...(extras.checked === undefined ? {} : { checked: extras.checked }),
    ...(extras.danger === undefined ? {} : { danger: extras.danger }),
  };
}

export const sep: ContextMenuSeparator = { kind: 'separator' };

function visibleEntries(items: readonly ContextMenuEntry[]): ContextMenuEntry[] {
  const next: ContextMenuEntry[] = [];
  for (const entry of items) {
    if (entry.kind === 'separator') {
      if (next.length === 0 || next[next.length - 1]?.kind === 'separator') continue;
      next.push(entry);
      continue;
    }
    next.push(entry);
  }
  if (next[next.length - 1]?.kind === 'separator') next.pop();
  return next;
}

function host(): HTMLElement | undefined {
  const node = document.getElementById(HOST_ID);
  return node instanceof HTMLElement ? node : undefined;
}

function ensureHost(): HTMLElement {
  const existing = host();
  if (existing !== undefined) return existing;
  const menu = document.createElement('div');
  menu.id = HOST_ID;
  menu.className = 'ctx-menu';
  menu.hidden = true;
  menu.role = 'menu';
  menu.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    const id = button?.dataset.id;
    if (button === null || button.disabled || id === undefined) return;
    const select = onSelect;
    hideContextMenu();
    select?.(id);
  });
  document.body.append(menu);
  return menu;
}
