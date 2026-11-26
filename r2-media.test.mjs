import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { sendR2Video } from './cloudflare-assets/fit-video-transfer.mjs';

const workerSource = await readFile(new URL('./cloudflare-worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'))).default;
const origin = 'https://fit-connect.example';
const base = 'https://test.supabase.co';
const credential = 'test-coach';
const date = '2026-11-23';
const partBytes = 6 * 1024 * 1024;
const memberId = 'test-member-id';

function fakeBucket() {
  const objects = new Map();
  const uploads = new Map();
  const head = async path => objects.get(path) ?? null;
  return {
    head,
    async put(path, body, options) {
      if (objects.has(path)) {
        await body.cancel();
        return null;
      }
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const object = { bytes, size: bytes.length, httpMetadata: options.httpMetadata };
      objects.set(path, object);
      return object;
    },
    async get(path, { range } = {}) {
      const object = await head(path);
      if (!object) return null;
      const bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes;
      return { ...object, body: bytes };
    },
    async createMultipartUpload(path, options) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, { path, options, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(path, uploadId) {
      const upload = uploads.get(uploadId);
      assert.equal(upload.path, path);
      return {
        async uploadPart(partNumber, body) {
          upload.parts.set(partNumber, Buffer.from(await new Response(body).arrayBuffer()));
          return { partNumber, etag: String(partNumber).repeat(192) };
        },
        async complete(parts) {
          const bytes = Buffer.concat(parts.map(({ partNumber }) => upload.parts.get(partNumber)));
          objects.set(path, { bytes, size: bytes.length, httpMetadata: upload.options.httpMetadata });
          uploads.delete(uploadId);
        }
      };
    }
  };
}

test('R2 media uses member-scoped records and preserves existing Supabase playback', async t => {
  const rows = new Map();
  const upstream = globalThis.fetch;
  const env = { FIT_MEDIA: fakeBucket(), SUPABASE_URL: base, SUPABASE_SECRET_KEY: 'test', TRAINER_PASSWORD: credential, MEMBER_SESSION_SECRET: 'test-only-session-secret-with-at-least-32-bytes' };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin === origin) return worker.fetch(new Request(input, options), env);
    assert.equal(url.origin, base);
    if (url.pathname === '/rest/v1/fit_members') {
      const name = url.searchParams.get('name');
      return Response.json([{ id: name === 'eq.Another member' ? 'different-id' : memberId, is_archived: false }]);
    }
    if (url.pathname === '/rest/v1/fit_direct_videos') {
      if (options.method === 'POST') {
        const row = JSON.parse(options.body);
        if (rows.has(row.id)) return Response.json([]);
        rows.set(row.id, { ...row, state: 'pending' });
        return Response.json([rows.get(row.id)]);
      }
      const row = rows.get(url.searchParams.get('id')?.slice(3));
      if (!row || url.searchParams.get('member_id') !== 'eq.' + row.member_id) return Response.json([]);
      if (options.method === 'PATCH') Object.assign(row, JSON.parse(options.body));
      return Response.json([row]);
    }
    if (url.pathname.startsWith('/storage/v1/object/sign/fit-direct-videos/'))
      return Response.json({ signedURL: '/object/sign/legacy-video?token=mock-only' });
    if (url.pathname.startsWith('/storage/v1/object/upload/sign/fit-direct-videos/'))
      return Response.json({ url: '/object/upload/sign/legacy-upload?token=mock-only' });
    assert.fail('Unexpected upstream request ' + url.pathname);
  };
  t.after(() => { globalThis.fetch = upstream; });
  const record = (action, params, overrides = {}, runtime = env) => worker.fetch(new Request(origin + '/api/records', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, member: 'Test member', password: credential, date, ...params, ...overrides })
  }), runtime);
  const create = async (id, size, runtime = env) => {
    const response = await record('directVideoBegin', { id, size, name: 'test.mp4', mime: 'video/mp4' }, {}, runtime);
    assert.equal(response.status, 200);
    return response.json();
  };
  const media = (url, options) => worker.fetch(new Request(url, options), env);
  const small = crypto.randomUUID();
  const begin = await create(small, 4);
  assert.equal(begin.storage, 'r2');
  assert.equal((await record('directVideoFinish', { id: small })).status, 409);
  assert.equal((await media(begin.url)).status, 403);
  const put = (payload, originHeader = origin) => media(begin.url, {
    method: 'PUT', body: payload, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(payload.length), Origin: originHeader }
  });
  assert.equal((await put('abc')).status, 422);
  assert.equal((await put('abcd', 'https://other.example')).status, 403);
  assert.equal((await put('abcd')).status, 204);
  assert.equal((await put('wxyz')).status, 204);
  assert.equal((await record('directVideoFinish', { id: small })).status, 200);
  assert.equal((await record('directVideoPlay', { id: small }, { member: 'Another member' })).status, 404);
  const play = await (await record('directVideoPlay', { id: small })).json();
  const signedUrl = new URL(play.url);
  signedUrl.searchParams.set('grant', signedUrl.searchParams.get('grant') + '.modified');
  assert.equal((await media(signedUrl)).status, 403);
  assert.equal((await media(play.url, { method: 'PUT' })).status, 403);
  assert.equal(await (await media(play.url)).text(), 'abcd');
  const head = await media(play.url, { method: 'HEAD' });
  assert.equal(head.headers.get('Content-Length'), '4');
  assert.equal(head.headers.get('Cache-Control'), 'private, no-store');
  const range = await media(play.url, { headers: { Range: 'bytes=-2' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), 'bytes 2-3/4');
  assert.equal(await range.text(), 'cd');
  assert.equal((await media(play.url, { headers: { Range: 'bytes=4-' } })).status, 416);

  const large = crypto.randomUUID();
  const file = new Blob([new Uint8Array(partBytes * 8), 'end']);
  assert.ok(file.size > 50_000_000);
  const multipart = await create(large, file.size);
  const job = {};
  const sentParts = [];
  let interrupted = false;
  let activeParts = 0;
  let peakParts = 0;
  const transfer = async (url, body, headers, onProgress) => {
    const part = new URL(url).searchParams.get('part');
    sentParts.push(part);
    activeParts++;
    peakParts = Math.max(peakParts, activeParts);
    try {
      await new Promise(resolve => setTimeout(resolve, part === '2' ? 10 : 0));
      if (part === '1' && !interrupted) return { status: 403, ok: false };
      onProgress(50, Math.floor(body.size / 2));
      const response = await media(url, { method: 'PUT', body, headers: { ...headers, 'Content-Length': String(body.size) } });
      return { status: response.status, ok: response.ok, text: await response.text() };
    } finally {
      activeParts--;
    }
  };
  await assert.rejects(sendR2Video(file, multipart, job, transfer, () => {}, () => {}), /403/);
  assert.equal(activeParts, 0);
  assert.equal(job.r2Multipart.parts[0], undefined);
  assert.equal(job.r2Multipart.parts[1].partNumber, 2);
  interrupted = true;
  const progress = [];
  await sendR2Video(file, multipart, job, transfer, (_percent, bytes) => progress.push(bytes), () => {});
  assert.equal(peakParts, 2);
  assert.deepEqual(sentParts, ['1', '2', '1', '3', '4', '5', '6', '7', '8', '9']);
  assert.ok(progress[0] >= partBytes);
  assert.ok(progress.every((bytes, index) => bytes >= (progress[index - 1] ?? 0) && bytes <= file.size));
  assert.equal(progress.at(-1), file.size);
  assert.equal((await record('directVideoFinish', { id: large })).status, 200);
  const largePlay = await (await record('directVideoPlay', { id: large })).json();
  assert.equal(await (await media(largePlay.url, { headers: { Range: 'bytes=-3' } })).text(), 'end');

  const maximum = await create(crypto.randomUUID(), 100_000_000);
  assert.equal(maximum.storage, 'r2');
  const overLimit = await record('directVideoBegin', {
    id: crypto.randomUUID(), size: 100_000_001, name: 'too-large.mp4', mime: 'video/mp4'
  });
  assert.equal(overLimit.status, 413);
  const overLegacyLimit = await record('directVideoBegin', {
    id: crypto.randomUUID(), size: 50_000_001, name: 'large.mp4', mime: 'video/mp4'
  }, {}, { ...env, FIT_MEDIA: undefined });
  assert.equal(overLegacyLimit.status, 413);

  const old = crypto.randomUUID();
  const legacy = await create(old, 4, { ...env, FIT_MEDIA: undefined });
  assert.equal(new URL(legacy.url).origin, base);
  assert.equal(new URL((await create(old, 4)).url).origin, base, 'pending Supabase upload keeps its original provider');
  const row = rows.get(old);
  row.state = 'ready';
  assert.equal(new URL((await (await record('directVideoPlay', { id: old })).json()).url).origin, base);
  await env.FIT_MEDIA.put('r2/fit-direct-videos/' + row.storage_path, 'abcd', { httpMetadata: { contentType: 'video/mp4' } });
  const moved = await (await record('directVideoPlay', { id: old })).json();
  assert.equal(await (await media(moved.url)).text(), 'abcd');
});
