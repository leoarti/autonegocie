import { auth, functionsBaseUrl } from './config';

interface InvokeOptions {
  body?: unknown;
  headers?: Record<string, string>;
  method?: string;
}

export const firebaseFunctions = {
  async invoke<T = any>(name: string, options?: InvokeOptions): Promise<{ data: T | null; error: { message: string } | null }> {
    try {
      const headers: Record<string, string> = { ...(options?.headers ?? {}) };
      const user = auth.currentUser;
      if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;

      const method = (options?.method || (options?.body === undefined ? 'POST' : 'POST')).toUpperCase();
      if (method !== 'GET' && options?.body !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(`${functionsBaseUrl}/${name}`, {
        method,
        headers,
        body: method === 'GET' || options?.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const text = await response.text();
      const data = text ? safeJson(text) : null;

      if (!response.ok) {
        const message = typeof data === 'object' && data && 'error' in data
          ? String((data as { error: unknown }).error)
          : text || `Erro ${response.status} ao chamar ${name}`;
        return { data: null, error: { message } };
      }

      return { data: data as T, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao chamar Cloud Function.';
      return { data: null, error: { message } };
    }
  },
};

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
