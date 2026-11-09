import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const transient = new Set([408, 429, 500, 502, 503, 504]);
const redirects = new Set([301, 302, 303, 307, 308]);
const origins = new Set(["https://github.com", "https://api.github.com", "https://release-assets.githubusercontent.com", "https://objects.githubusercontent.com"]);
const apiOrigin = "https://api.github.com";
export class DownloadError extends Error {}

function checkedURL(value, base) {
  const url = new URL(value, base);
  if (!origins.has(url.origin) || url.username || url.password) throw new Error("Unexpected GitHub download redirect origin");
  return url;
}

async function requestRedirects(initial, accept, { request, apiToken }, signal) {
  let url = checkedURL(initial);
  for (let hop = 0; hop <= 5; hop++) {
    const api = url.origin === apiOrigin;
    // Release redirects are short-lived signed URLs. Do not reuse cached redirects.
    if (api && /\/releases\/assets\/\d+$/.test(url.pathname)) url.searchParams.set("_mybuddy_nonce", randomUUID());
    const headers = { Accept: accept, "User-Agent": "mybuddy-runner" };
    if (api) {
      headers["Cache-Control"] = "no-cache";
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
    }
    const response = await request(url.href, { headers, redirect: "manual", signal });
    if (!redirects.has(response.status)) return { response, host: url.hostname, api };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error("GitHub download redirect is missing a location");
    url = checkedURL(location, url);
  }
  throw new Error("Too many GitHub download redirects");
}

function diagnostic(response, host, api, authenticated) {
  const details = [`host=${host}`];
  if (api) details.push(`authentication=${authenticated ? "token" : "anonymous"}`);
  for (const name of ["x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
    const value = response.headers.get(name);
    if (value && /^\d+$/.test(value)) details.push(`${name}=${value}`);
  }
  return `GitHub download returned HTTP ${response.status} (${details.join(", ")})`;
}

export async function downloadGitHubBytes(url, accept, {
  request = fetch, wait = delay, apiToken = process.env.GITHUB_TOKEN || "", maxBytes = 64 * 1024 * 1024,
} = {}) {
  checkedURL(url);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let retryable = true;
    let pause = 2000;
    try {
      let result;
      try {
        result = await requestRedirects(url, accept, { request, apiToken }, AbortSignal.timeout(45_000));
      } catch (error) {
        if (/^(Unexpected GitHub|Too many GitHub|GitHub download redirect)/.test(error.message)) retryable = false;
        // Do not print fetch errors: they can contain signed URLs or request headers.
        if (!retryable) throw new Error(error.message);
        throw new DownloadError("GitHub download connection failed");
      }
      const { response, host, api } = result;
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        const after = response.headers.get("retry-after");
        const rateLimited = api && (response.status === 403 || response.status === 429) && (remaining === "0" || after !== null);
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const seconds = after !== null ? Number(after) : Math.ceil(reset - Date.now() / 1000);
        // A CDN 403 can be an expired signed URL. Retry the API, never the stale URL.
        const staleAsset = host.endsWith(".githubusercontent.com") && response.status === 403;
        retryable = transient.has(response.status) || staleAsset;
        if (rateLimited) {
          retryable = Number.isFinite(seconds) && seconds >= 0 && seconds <= 15;
          if (retryable) pause = Math.max(2000, seconds * 1000);
        }
        await response.body?.cancel().catch(() => {});
        const message = diagnostic(response, host, api, !!apiToken);
        if (retryable || response.status === 404) throw new DownloadError(message);
        throw new Error(message);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) { retryable = false; throw new Error("GitHub download exceeds the archive size limit"); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (!retryable || attempt === 2) {
        if (retryable) throw new DownloadError(`GitHub download failed after bounded retries${error instanceof DownloadError ? `: ${error.message}` : ""}`);
        throw error;
      }
      console.warn(`GitHub download attempt ${attempt}/2 failed; retrying in ${pause / 1000}s`);
      await wait(pause);
    }
  }
}
