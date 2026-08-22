import { AelionError } from '@aelionsdk/core';

export function errorMessage(error: unknown, fallback = '操作失败'): string {
  if (error instanceof AelionError) {
    const first = error.diagnostics[0];
    if (first !== undefined) {
      return first.entityId === undefined ? first.message : `${first.message}（${first.entityId}）`;
    }
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}

export function isIdleEditError(error: unknown): boolean {
  if (!(error instanceof AelionError)) return false;
  return error.diagnostics.some(
    diagnostic => diagnostic.code === 'COMMAND_NO_CHANGE' || diagnostic.code === 'TRANSACTION_EMPTY',
  );
}
