import { setTimeout as delay } from 'node:timers/promises';

class HttpFailure extends Error {
  constructor(status) { super(`download failed (${status})`); this.status = status; }
}

export async function downloadWithRetry(url, options, consume, {
  request = fetch, wait = delay, timeoutMs = 300_000, totalTimeoutMs = 600_000,
} = {}) {
  const deadline = Date.now() + totalTimeoutMs;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('download time limit exceeded');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    let response;
    try {
      response = await request(url, { ...options, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new HttpFailure(response.status);
      return await consume(response);
    } catch (error) {
      controller.abort();
      if (error instanceof HttpFailure && ![408, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      // Fetch rejects redirects rather than following them with credentials.
      if (error?.cause?.message === 'unexpected redirect') throw new Error('download redirect rejected');
      if (attempt === 4 || Date.now() >= deadline) throw new Error('download failed after bounded retries');
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => {});
    }
    console.log(`Retrying download, attempt ${attempt + 1}/4`);
    await wait(Math.min(1000 * attempt, Math.max(0, deadline - Date.now())));
  }
}
