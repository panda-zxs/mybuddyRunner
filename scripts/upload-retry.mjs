import { setTimeout } from "node:timers/promises";

export async function uploadWithRetry(request, filename, wait = setTimeout) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let response;
    try { response = await request(); } catch {
      if (attempt === 4) throw new Error(`artifact upload connection failed for ${filename}`);
    }
    if (response?.ok) { await response.body?.cancel(); return; }
    const status = response?.status;
    await response?.body?.cancel();
    if (response && ![408, 429, 500, 502, 503, 504].includes(status) || attempt === 4) {
      throw new Error(`artifact upload failed for ${filename} (${status ?? "connection error"})`);
    }
    console.log(`Retrying upload of ${filename}, attempt ${attempt + 1}/4`);
    await wait(5000 * attempt);
  }
}
