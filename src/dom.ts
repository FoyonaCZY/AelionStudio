export function requiredElement(selector: string): HTMLElement {
  const value = document.querySelector(selector);
  if (!(value instanceof HTMLElement)) throw new Error(`Missing editor element: ${selector}`);
  return value;
}

export function on(
  target: EventTarget,
  type: string,
  listener: EventListener,
  options?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

export function downloadBlob(bytes: Uint8Array, name: string, mimeType: string): void {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, name: string, mimeType: string): void {
  downloadBlob(new TextEncoder().encode(text), name, mimeType);
}
