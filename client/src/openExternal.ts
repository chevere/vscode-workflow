/**
 * Validates a URL received from a WebView `openExternal` message.
 *
 * Returns the URL string only when the scheme is `https:`.
 * Any other scheme (file://, vscode://, javascript:, etc.) is rejected.
 */
export function validateOpenExternal(url: unknown): string | null {
  if (typeof url !== 'string') return null;

  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, '');
  } catch {
    return null;
  }

  if (scheme !== 'https') return null;

  return url;
}
