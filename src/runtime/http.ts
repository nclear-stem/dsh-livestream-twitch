/** Injectable HTTP boundary. Production uses global fetch; tests pass a fake that returns Response objects. */

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export const defaultFetch: HttpFetch = (url, init) => fetch(url, init);

export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/** Twitch error bodies look like {"error":"Unauthorized","status":401,"message":"..."}. */
export function errorMessage(body: unknown, fallback: string): string {
  const b = body as { message?: unknown; error?: unknown } | undefined;
  const msg = typeof b?.message === 'string' ? b.message : typeof b?.error === 'string' ? b.error : '';
  return msg || fallback;
}

export function form(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}
