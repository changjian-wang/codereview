import { randomUUID } from 'node:crypto';

/** Escapes the three HTML-significant characters for safe text-node interpolation. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escapes a string for use inside a double-quoted HTML attribute. */
export function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;');
}

/** Cryptographically strong, unguessable nonce for a webview CSP. */
export function nonce(): string {
  return randomUUID().replace(/-/g, '');
}
