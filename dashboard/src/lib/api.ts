const API_TOKEN_STORAGE_KEY = "monitor.apiToken";

function envApiToken(): string | null {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }).env;
  return env?.["VITE_MONITOR_API_TOKEN"]?.trim() || null;
}

export function getMonitorApiToken(): string | null {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim();
    if (stored) return stored;
  }
  return envApiToken();
}

export function monitorApiHeaders(headers: HeadersInit = {}): Headers {
  const next = new Headers(headers);
  const authValue = getMonitorApiToken();
  if (authValue && !next.has("Authorization")) {
    next.set("Authorization", `Bearer ${authValue}`);
  }
  return next;
}

export function monitorApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: monitorApiHeaders(init.headers),
  });
}
