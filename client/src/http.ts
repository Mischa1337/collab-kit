/** Calls to the routes of CK, the one place that speaks HTTP. */

import { CollabKitError } from './api.ts';

/** Query parameters of a call; one left undefined is not sent. */
export type Query = Readonly<Record<string, string | number | undefined>>;

/** What a call sends besides method and path. */
export interface CallOptions {
  readonly query?: Query;
  readonly body?: unknown;
}

/** One call with this token: the answer as JSON, a refusal as CollabKitError. */
export async function callRoute<Answer>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Answer> {
  const response = await fetchRoute(baseUrl, token, method, path, options);
  return (await response.json()) as Answer;
}

/** One call with this token, the answer as it came; a refusal as CollabKitError. */
export async function fetchRoute(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  // Only the parameters that carry something go into the address.
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      query.set(name, String(value));
    }
  }
  const search = query.toString();

  const response = await fetch(`${baseUrl}${path}${search === '' ? '' : `?${search}`}`, {
    method,
    headers:
      options.body === undefined
        ? { Authorization: `Bearer ${token}` }
        : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    throw new CollabKitError(response.status, await reasonOf(response));
  }
  return response;
}

/** The reason CK names in a refusal, or the status text where it names none. */
async function reasonOf(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);

  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body;
    if (typeof error === 'string') {
      return error;
    }
  }
  return response.statusText;
}
