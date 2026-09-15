import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadWithRetry } from './download-retry.mjs';

test('retries interrupted bodies and transient responses without relaxing redirect policy', async () => {
  let attempts = 0;
  const value = await downloadWithRetry('https://example.test/source', {}, r => r.text(), {
    wait: async () => {},
    request: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      attempts++;
      if (attempts === 1) return new Response('', { status: 503 });
      if (attempts === 2) return new Response(new ReadableStream({ start(c) { c.error(new Error('dropped')); } }));
      return new Response('complete');
    },
  });
  assert.equal(value, 'complete');
  assert.equal(attempts, 3);
});

test('does not retry authentication failures or redirect responses', async () => {
  for (const status of [401, 403, 302]) {
    let attempts = 0;
    await assert.rejects(downloadWithRetry('https://example.test', {}, r => r.text(), {
      request: async () => { attempts++; return new Response('', { status }); },
      wait: async () => {},
    }), new RegExp(String(status)));
    assert.equal(attempts, 1);
  }
});

test('aborts stalled downloads and bounds retries without exposing request secrets', async () => {
  let attempts = 0;
  await assert.rejects(downloadWithRetry('https://example.test', { headers: { Authorization: 'secret' } }, r => r.text(), {
    timeoutMs: 5, totalTimeoutMs: 1000, wait: async () => {},
    request: (_url, { signal }) => new Promise((_resolve, reject) => {
      attempts++;
      signal.addEventListener('abort', () => reject(new Error('secret')));
    }),
  }), /download failed after bounded retries/);
  assert.equal(attempts, 4);
});
