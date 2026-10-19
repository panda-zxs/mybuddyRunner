import { setTimeout as delay } from "node:timers/promises";

const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);

// Bound connection/header waits without limiting a subsequent installer download.
// Keep authentication, missing-artifact and conflict responses for the caller;
// never log URLs, headers or native errors which may contain signed credentials.
export async function fetchWithRetry(url, options, { label = "Update Server request", request = fetch, wait = delay, timeoutMs = 30_000 } = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await request(url, { ...options, signal: options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
    } catch {
      if (options?.signal?.aborted) throw new Error(`${label} cancelled`);
      if (attempt === 4) throw new Error(`${label} connection failed after 4 attempts`);
    } finally {
      clearTimeout(timer);
    }
    if (response && (!transientStatuses.has(response.status) || attempt === 4)) return response;
    await response?.body?.cancel().catch(() => {});
    console.log(`Retrying ${label}, attempt ${attempt + 1}/4`);
    await wait(5000 * attempt);
  }
}
