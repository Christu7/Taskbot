/**
 * Wraps the built-in fetch() with an AbortController timeout.
 *
 * Without a timeout a hung external endpoint holds a Cloud Function instance
 * open until the function-level deadline fires (up to 300 s of idle compute).
 * All raw fetch() calls to external APIs should go through this wrapper.
 *
 * @param url       - Target URL
 * @param options   - Standard RequestInit options (method, headers, body, …)
 * @param timeoutMs - Abort after this many milliseconds (default: 15 000)
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15_000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}
