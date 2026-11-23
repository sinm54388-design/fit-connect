import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./cloudflare-assets/v2.html', import.meta.url), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1].replace('    initLiveMemberData();\n', '');
const workerSource = fs.readFileSync(new URL('./cloudflare-worker.js', import.meta.url), 'utf8');
const date = '2026-11-19';

function app(fetch, query = '&date=' + date, storage = new Map()) {
  const elements = new Map();
  const document = {
    addEventListener() {}, querySelector() { return null; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        addEventListener() {}, querySelectorAll() { return []; }, replaceChildren() {},
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} }, style: {}
      });
      return elements.get(id);
    }
  };
  const location = { protocol: 'https:', hostname: 'fixture.test', search: '?name=QA&token=fixture' + query };
  const context = vm.createContext({
    URL, URLSearchParams, Blob, Uint8Array, atob, structuredClone, fetch, document, location,
    navigator: {}, setTimeout, clearTimeout, FormData, console, performance,
    requestAnimationFrame() {},
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    window: { location, addEventListener() {}, crypto }
  });
  vm.runInContext(source, context);
  const run = expression => vm.runInContext(expression, context);
  run('state.isLive = true; state.workoutReadVerified = true; globalThis.messages = []; showToast = message => messages.push(message); renderAll = () => {};');
  return run;
}

test('one session exchange handles concurrent expired records requests', async () => {
  let exchanges = 0;
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
    if (body.action === 'memberSession') {
      exchanges++;
      return Response.json({ status: 'success', session: 'renewed', exp: Date.now() + 3600000 });
    }
    return body.session === 'renewed' ? Response.json({}) :
      Response.json({ status: 'denied', code: 'session_invalid' }, { status: 403 });
  });
  run("state.session = 'expired'; state.sessionExpires = Date.now() + 3600000;");
  await run("Promise.all(['read', 'memberInsights', 'columnList'].map(action => postRecords({action, member: state.memberName, date: state.selectedDate, session: state.session})))");
  assert.equal(exchanges, 1);
  assert.equal(run('state.session'), 'renewed');
});

test('an older or denied date read cannot remain on the current screen', async () => {
  let releaseOldRead;
  const oldRead = new Promise(resolve => { releaseOldRead = resolve; });
  const run = app(async (url, request) => {
    const body = JSON.parse(request.body);
    if (url === '/api/apps-script') return Response.json({ status: 'success' });
    if (body.action !== 'read') return Response.json({ status: 'success' });
    if (body.date === date) return oldRead;
    if (body.date === '2026-11-21') return Response.json({ status: 'denied', code: 'unauthorized' }, { status: 403 });
    return Response.json({ headerMessage: 'newer' });
  });
  run("state.session = 'valid'; state.sessionExpires = Date.now() + 3600000;");
  const older = run('loadMemberDateData(state.selectedDate)');
  await run("state.selectedDate = '2026-11-20'; loadMemberDateData(state.selectedDate)");
  releaseOldRead(Response.json({ headerMessage: 'older' }));
  await older;
  assert.equal(run('state.record.headerMessage'), 'newer');
  await run("state.selectedDate = '2026-11-21'; loadMemberDateData(state.selectedDate)");
  assert.equal(run('state.mealReadVerified'), false);
  assert.equal(run('state.record.headerMessage'), '');
  assert.match(run('messages.at(-1)'), /불러오지 못했어요/);
});

test('cold member date renders before optional calls and reuses published columns', async () => {
  const calls = [];
  const run = app(async (url,request)=>{
    if (url === '/api/apps-script') return Response.json({ status: 'success' });
    const body = JSON.parse(request.body);
    calls.push({action:body.action,session:body.session});
    if (body.action==='memberSession')
      return Response.json({status:'success',session:'verified',exp:Date.now()+3600000});
    if (body.action==='read') return Response.json({headerMessage:'today first'});
    return Response.json({status:'success',columns:[],days:[]});
  });
  run('globalThis.frames = []; globalThis.requestAnimationFrame = cb => frames.push(cb); refreshMemberSummaries = () => {};');
  await run('loadMemberDateData(state.selectedDate)');
  assert.deepEqual(calls.map(item=>item.action),['memberSession','read']);
  assert.equal(run('state.record.headerMessage'),'today first');
  assert.equal(run('state.loading'),false);
  run('frames.shift()(); frames.shift()();');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(item=>item.action==='columnList').length,1);
  assert.ok(calls.slice(1).every(item=>item.session==='verified'));
  await run("state.selectedDate = '2026-11-20'; loadMemberDateData(state.selectedDate)");
  run('frames.shift()(); frames.shift()();');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(item=>item.action==='columnList').length,1);
});

test('HTTP 200 denial does not trigger a full-record write or a success', async () => {
  const calls = [];
  const run = app(async (_, request) => {
    calls.push(JSON.parse(request.body));
    return Response.json({ status: 'denied' });
  });
  assert.equal(await run("savePatchLive({diet:{water:500}})"), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'patchData');
  assert.equal(calls[0].data, undefined);
  assert.match(run('messages.at(-1)'), /저장을 확인하지 못했어요/);
});

test('meal save scopes both writes and only uploads a newly selected photo', async () => {
  const calls = [];
  let denied = true;
  const run = app(async (url, request) => {
    const data = JSON.parse(request.body);
    calls.push([url, data]);
    if (url === '/api/apps-script') return Response.json({ status: 'success' });
    return denied ? Response.json({ status: 'denied' }) :
      Response.json({ status: 'success', data: { diet: data.diet } });
  });
  run("state.session='valid'; globalThis.meal={desc:'밥',cal:'100',foods:[{name:'밥'}],photos:['https://old-photo.test/rice']};");
  await assert.rejects(run("saveMealLive('QA', state.selectedDate, 'lunch', meal, '')"));
  denied = false;
  await run("saveMealLive('QA', state.selectedDate, 'lunch', meal, 'data:image/jpeg;base64,AAAA')");
  const patch = { diet: { lunch: { desc: '밥', cal: '100', foods: [{ name: '밥' }] } } };
  assert.deepEqual(calls[0][1].patch, patch);
  assert.deepEqual(calls[1][1].diet, patch.diet);
  assert.deepEqual(calls[2][1].patch, patch);
  assert.deepEqual(calls[3][1].diet.lunch.photos, ['data:image/jpeg;base64,AAAA']);
  assert.equal(calls[3][1].session, 'valid');
});

test('coach patches target the selected member with coach auth and preserve unrelated fields', async () => {
  const calls = [];
  const run = app(async (_, request) => {
    calls.push(JSON.parse(request.body));
    return Response.json({ status: 'success' });
  });
  run("state.appMode = 'coach'; state.trainerPassword = 'fixture-coach';");
  assert.equal(await run("savePatchLive({routines:[],feedback:{workout:'확인'}}, 'target')"), true);
  assert.deepEqual(calls, [{
    member: 'target', date, password: 'fixture-coach',
    data: { routines: [], feedback: { workout: '확인' } }
  }]);
});

test('a failed set write is restored after reload without replacing coach routine edits', async () => {
  const store = new Map();
  const offline = app(async () => { throw Error('offline'); }, undefined, store);
  offline("state.record.routines=[{id:'exercise',sets:2,completedSets:[true,false]}]; enqueueWorkoutSave(state.record.routines[0], [0])");
  await offline("retryWorkoutSave(); flushWorkoutSave(workoutSaveJobs.values().next().value)");
  assert.equal(store.size, 1);
  const calls = [];
  const reopened = app(async (_, request) => {
    calls.push(JSON.parse(request.body));
    return Response.json({ status: 'success' });
  }, undefined, store);
  reopened("state.record.routines=[{id:'exercise',sets:2,weight:40,completedSets:[false,true]}]; restoreWorkoutSave()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened('state.record.routines[0].completedSets[0]'), true);
  assert.equal(reopened('state.record.routines[0].weight'), 40);
  assert.equal(reopened('state.record.routines[0].completedSets[1]'), true);
  assert.equal(calls[0].action, 'setProgressBatch');
  assert.deepEqual(calls[0].changes, [{ id: 'exercise', index: 0, checked: true }]);
  assert.equal(calls[0].date, date);
  assert.equal(store.size, 0);
});

test('photo merge prefers the stored photo, preserves food fields and honors tombstones', () => {
  const run = app(() => { throw Error('unexpected network request'); }, '&date=2026-13-01');
  assert.equal(run('state.selectedDate'), run('getTodayKST()'));
  run(`
    globalThis.oldDiet = {lunch:{desc:'old',photo:'https://old.test/image'},water:0};
    globalThis.newDiet = {lunch:{desc:'new',foods:[{name:'밥'}],photos:['direct:new']},water:250};
  `);
  assert.equal(run("mergeDietRecords(oldDiet,newDiet).lunch.photos[0]"), 'direct:new');
  assert.equal(run("mergeDietRecords(oldDiet,newDiet).lunch.foods[0].name"), '밥');
  assert.equal(run("mergeDietRecords(oldDiet,newDiet).water"), 0);
  assert.equal(run("extractPhotoSrc(mergeDietRecords(oldDiet,newDiet,['lunch']).lunch)"), '');
});

test('upload finish retries reuse the transferred file and playback sign calls are shared', async () => {
  const actions = [];
  let finishCount = 0;
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
    actions.push(body);
    if (body.action === 'directVideoBegin') return Response.json({ status: 'success', url: 'https://storage.test/put' });
    if (body.action === 'directVideoFinish') {
      if (++finishCount === 1) return Response.json({ status: 'error' }, { status: 502 });
      return Response.json({ status: 'success' });
    }
    return Response.json({ status: 'success', url: 'https://storage.test/play.mp4' });
  });
  run("state.session='valid'; globalThis.attempt={}; globalThis.puts=0; globalThis.prepares=0; globalThis.sentSize=0; prepareDirectVideo=async()=>{prepares++;return {size:40,type:'video/mp4'}}; xhrVideoTransfer=async (_,file)=>{puts++;sentSize=file.size;return {ok:true}};");
  const upload = "uploadDirectVideoFile({size:100,type:'video/mp4',name:'QA.mp4'}, 'QA','fixture','',null,attempt)";
  await assert.rejects(run(upload));
  run("state.selectedDate='2026-11-20'");
  const id = await run(upload);
  assert.equal(run('puts'), 1);
  assert.equal(run('prepares'), 1);
  assert.equal(actions[0].size, 40);
  assert.equal(run('sentSize'), 40);
  assert.equal(actions[1].id, actions[2].id);
  assert.ok(actions.every(item => item.date === date));
  await run(`Promise.all([resolvePlayableVideoUrl('${id}'),resolvePlayableVideoUrl('${id}')])`);
  assert.equal(actions.filter(item => item.action === 'directVideoPlay').length, 1);
  assert.match(run("buildVideoPlayerHtml('https://storage.test/play.mp4')"), /autoplay muted playsinline/);
});

test('concurrent worker requests share one member ID lookup and keep projects isolated', async () => {
  const context = vm.createContext({});
  vm.runInContext(workerSource.slice(workerSource.indexOf('const memberCache'),workerSource.indexOf('function shiftDay')),context);
  const lookup = vm.runInContext('lookupMember',context);
  let calls = 0;
  const query = async () => [{id:++calls}];
  assert.deepEqual(await Promise.all([
    lookup('project-a','member',query),lookup('project-a','member',query)
  ]),[1,1]);
  assert.equal(await lookup('project-b','member',query),2);
  assert.equal(await lookup('project-a','member',query),1);
});

test('Worker retries a check-in write conflict and preserves intervening record fields', async () => {
  const originalVersion = '2026-11-19T04:00:00.000Z';
  const currentVersion = '2026-11-19T04:00:01.000Z';
  let reads = 0;
  let patches = 0;
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/fit_members')) return Response.json([{ id: 'test-member' }]);
    if (init.method !== 'PATCH') {
      reads++;
      return Response.json([{ id: 'row', updated_at: reads === 1 ? originalVersion : currentVersion,
        data: { diet: { water: reads === 1 ? 500 : 1000 }, dailyCheckin: { diet: 'done' } } }]);
    }
    patches++;
    if (patches === 1) {
      assert.equal(target.searchParams.get('updated_at'), 'eq.' + originalVersion);
      return Response.json([]);
    }
    assert.equal(target.searchParams.get('updated_at'), 'eq.' + currentVersion);
    return Response.json([{ data: JSON.parse(init.body).data }]);
  };
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ fetch, URL, Response, Request, Headers, TextEncoder, TextDecoder, AbortSignal, performance, crypto, btoa, atob })
  });
  await mod.link(() => {});
  await mod.evaluate();
  const response = await mod.namespace.default.fetch(new Request('https://fixture.test/api/records', {
    method: 'POST', body: JSON.stringify({ action: 'dailyCheckin', password: 'fixture', member: 'QA', date, checkin: { mood: 'good' } })
  }), { TRAINER_PASSWORD: 'fixture', SUPABASE_URL: 'https://storage-fixture.supabase.co', SUPABASE_SECRET_KEY: 'fixture' });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(patches, 2);
  assert.equal(data.diet.water, 1000);
  assert.equal(data.dailyCheckin.diet, 'done');
  assert.equal(data.dailyCheckin.mood, 'good');
});

test('Worker diet save preserves another writer’s new day and confirms the photo', async () => {
  const memberId = 'fixture-diet-member';
  const image = 'data:image/jpeg;base64,AAAA';
  const version = '2026-11-19T01:00:01.000Z';
  let row;
  let photo;
  const writes = [];
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/fit_members')) return Response.json([{ id: memberId }]);
    if (pathname.endsWith('/fit_meal_photos')) {
      if (init.method === 'POST') {
        photo = JSON.parse(init.body);
        return Response.json([photo]);
      }
      return Response.json(photo ? [photo] : []);
    }
    if (pathname.endsWith('/fit_coach_feedback')) return Response.json([]);
    assert.ok(pathname.endsWith('/fit_daily_records'), pathname);
    if (!init.method) return Response.json(row ? [row] : []);
    writes.push(init.method);
    const body = JSON.parse(init.body);
    if (init.method === 'POST') {
      assert.equal(init.headers.Prefer, 'return=representation');
      row = {
        id: 'fixture-row', updated_at: version,
        data: { routines: [{ id: 'keep' }], diet: { breakfast: { desc: '기존 아침' } } }
      };
      return new Response(null, { status: 409 });
    }
    assert.equal(searchParams.get('updated_at'), 'eq.' + version);
    assert.equal(body.data.diet.lunch.photos.length, 0);
    row = { id: row.id, ...body };
    return Response.json([row]);
  };
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ fetch, URL, Response, Request, Headers, TextEncoder, TextDecoder, AbortSignal, performance, crypto, btoa, atob })
  });
  await mod.link(() => {});
  await mod.evaluate();
  const env = { TRAINER_PASSWORD: 'fixture', SUPABASE_URL: 'https://diet-fixture.supabase.co', SUPABASE_SECRET_KEY: 'fixture' };
  const request = (action, extra) => mod.namespace.default.fetch(new Request('https://fixture.test/api/records', {
    method: 'POST', body: JSON.stringify({ action, password: 'fixture', member: 'QA Diet', date, ...extra })
  }), env);
  const saved = await request('dietSave', { diet: { lunch: { desc: '밥', foods: [{ name: '밥' }], photos: [image] } } });
  assert.equal(saved.status, 200);
  const read = await request('read');
  assert.equal(read.status, 200);
  const record = await read.json();
  assert.deepEqual(writes, ['POST', 'PATCH']);
  assert.equal(record.routines[0].id, 'keep');
  assert.equal(record.diet.breakfast.desc, '기존 아침');
  assert.equal(record.diet.lunch.foods[0].name, '밥');
  assert.equal(record.diet.lunch.photos[0], image);
});

test('video optimization keeps HDR and small savings intact and checks MP4 output before switching files', async () => {
  class Input {
    constructor({ source }) {
      this.metadata = source.file.metadata;
      this.video = {
        getDisplayWidth: async () => this.metadata.width,
        getDisplayHeight: async () => this.metadata.height,
        hasHighDynamicRange: async () => this.metadata.hdr,
        canDecode: async () => this.metadata.supported !== false
      };
      this.audio = this.metadata.audio ? [{}] : [];
    }
    async getDurationFromMetadata() { return this.metadata.duration; }
    async getPrimaryVideoTrack() { return this.video; }
    async getVideoTracks() { return [this.video]; }
    async getAudioTracks() { return this.audio; }
    dispose() {}
  }
  let encodedMetadata;
  let converted = 0;
  let stripAudio = false;
  const moduleExports = {
    Input, MP4: {}, QTFF: {}, WEBM: {}, BufferTarget: class {}, Mp4OutputFormat: class {},
    Output: class { constructor({ target }) { this.target = target; } },
    BlobSource: class { constructor(file) { this.file = file; } },
    Conversion: {
      async init({ input, output, video }) {
        converted++;
        assert.equal(video.codec, 'avc');
        assert.equal(video.hardwareAcceleration, 'prefer-hardware');
        assert.deepEqual([video.width, video.height], [1080, 1920]);
        return {
          isValid: true, utilizedTracks: [...await input.getVideoTracks(), ...await input.getAudioTracks()],
          async execute() {
            output.target.buffer = new ArrayBuffer(12_000_000);
            encodedMetadata = { duration: 24, width: video.width, height: video.height, audio: !stripAudio };
            this.onProgress(0.5);
          }
        };
      }
    }
  };
  const context = vm.createContext({
    File: class {
      constructor([bytes], name, { type }) {
        Object.assign(this, { size: bytes.byteLength, name, type, metadata: encodedMetadata });
      }
    }
  });
  const dependency = new vm.SyntheticModule(Object.keys(moduleExports), function () {
    for (const [name, value] of Object.entries(moduleExports)) this.setExport(name, value);
  }, { context });
  const source = fs.readFileSync(new URL('./cloudflare-assets/fit-video-encode.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => dependency);
  await module.evaluate();
  const compress = module.namespace.compressIfWorthwhile;
  const sourceVideo = { name: 'portrait.MOV', size: 36_000_000, metadata: {
    duration: 24, width: 2160, height: 3840, audio: true
  } };
  const signal = new AbortController().signal;
  const small = { ...sourceVideo, size: 15_000_000 };
  const hdr = { ...sourceVideo, metadata: { ...sourceVideo.metadata, hdr: true } };
  assert.equal(await compress(small, signal, () => {}), small);
  assert.equal(await compress(hdr, signal, () => {}), hdr);
  const unsupported = { ...sourceVideo, metadata: { ...sourceVideo.metadata, supported: false } };
  assert.equal(await compress(unsupported, signal, () => {}), unsupported);
  assert.equal(converted, 0);
  const progress = [];
  const result = await compress(sourceVideo, signal, percent => progress.push(percent));
  assert.equal(result.type, 'video/mp4');
  assert.equal(result.size, 12_000_000);
  assert.deepEqual(progress, [50]);
  stripAudio = true;
  assert.equal(await compress(sourceVideo, signal, () => {}), sourceVideo);
});

test('large uploads send data during creation and resume from Storage’s confirmed offset', async () => {
  const { sendResumableVideo } = await import('./cloudflare-assets/fit-video-transfer.mjs');
  const chunk = 6 * 1024 * 1024;
  const file = new Blob([new Uint8Array(chunk * 2 + 1200)]);
  const endpoint = 'https://storage.fixture.test/storage/v1/upload/resumable/sign';
  const location = endpoint + '/fixture-1';
  const options = { tusEndpoint: endpoint, uploadToken: 'test-only', objectName: 'member-fixture/clip.mp4' };
  const job = {};
  const phases = [];
  const requests = [];
  const progress = [];
  let serverOffset = 0;
  const transfer = async (url, body, headers, onProgress, method) => {
    requests.push(method);
    assert.equal(headers['x-signature'], 'test-only');
    if (method === 'POST') {
      assert.equal(url, endpoint);
      assert.equal(headers['Upload-Length'], String(file.size));
      assert.equal(body.size, chunk);
      serverOffset = chunk;
      return { ok: true, location, offset: String(serverOffset) };
    }
    assert.equal(url, location);
    if (method === 'HEAD') return { ok: true, offset: String(serverOffset) };
    assert.equal(Number(headers['Upload-Offset']), serverOffset);
    serverOffset += body.size;
    onProgress(99, body.size);
    if (serverOffset === chunk * 2) throw new Error('connection dropped after the chunk was accepted');
    return { ok: true, offset: String(serverOffset) };
  };
  assert.equal(await sendResumableVideo(file, 'video/mp4', options, job, transfer,
    (_percent, loaded) => progress.push(loaded), message => phases.push(message)), true);
  assert.deepEqual(requests, ['POST', 'PATCH', 'HEAD', 'PATCH']);
  assert.equal(serverOffset, file.size);
  assert.equal(job.tusUrl, location);
  assert.equal(progress.at(-1), file.size);
  assert.match(phases[0], /이어서 전송/);
});

test('clean fallback leaves the resumable URL unset and never forwards the signature across hosts', async () => {
  const { sendResumableVideo } = await import('./cloudflare-assets/fit-video-transfer.mjs');
  const endpoint = 'https://storage.fixture.test/storage/v1/upload/resumable/sign';
  const options = { tusEndpoint: endpoint, uploadToken: 'test-only', objectName: 'member-fixture/clip.mov' };
  const job = {};
  const file = new Blob([new Uint8Array(1024)]);
  assert.equal(await sendResumableVideo(file, 'video/quicktime', options, job,
    async () => ({ ok: false, status: 404 }), () => {}, () => {}), false);
  assert.equal(job.tusUrl, undefined);
  await assert.rejects(sendResumableVideo(file, 'video/quicktime', options, job,
    async () => ({ ok: true, location: 'https://other.fixture.test/path' }), () => {}, () => {}), /이어 올리기 주소/);
  assert.equal(job.tusUrl, undefined);
});

test('the video file picker accepts common iPhone recordings and rejects documents', () => {
  const run = app(async () => Response.json({}));
  assert.equal(run("normalizeVideoMime({name:'IMG_2134.MOV',type:''})"), 'video/quicktime');
  assert.equal(run("normalizeVideoMime({name:'export.m4v',type:'video/x-m4v'})"), 'video/mp4');
  assert.equal(run("normalizeVideoMime({name:'document.pdf',type:'application/pdf'})"), '');
  assert.match(html, /id="member-vid-file" type="file"/);
});

test('a large source can upload if preparation produces a file below the Storage limit', async () => {
  const calls = [];
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    return Response.json({ status: 'success', url: 'https://storage.fixture.test/put' });
  });
  run("state.session='valid'; xhrVideoTransfer=async()=>({ok:true}); prepareDirectVideo=async()=>({name:'compact.mp4',type:'video/mp4',size:15_000_000});");
  await run("uploadDirectVideoFile({name:'original.mov',size:64_000_000},'QA','fixture','',null)");
  assert.equal(calls[0].size, 15_000_000);
  run("prepareDirectVideo=async file=>file;");
  await assert.rejects(run("uploadDirectVideoFile({name:'original.mov',size:64_000_000},'QA','fixture','',null)"), /50MB 이하로 줄이지 못했어요/);
  assert.equal(calls.length, 2);
});
