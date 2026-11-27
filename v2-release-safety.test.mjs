import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./cloudflare-assets/v2.html', import.meta.url), 'utf8');
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1].replace('    initLiveMemberData();\n', '');
const workerSource = fs.readFileSync(new URL('./cloudflare-worker.js', import.meta.url), 'utf8');
const date = '2026-11-19';

function app(fetch, query = '&date=' + date, storage = new Map(), pageUrl) {
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
  const location = new URL(pageUrl ?? 'https://fixture.test/?name=QA&token=fixture' + query);
  const context = vm.createContext({
    URL, URLSearchParams, Blob, Uint8Array, TextEncoder, atob, structuredClone, fetch, document, location,
    navigator: {}, setTimeout, clearTimeout, FormData, console, performance,
    requestAnimationFrame() {},
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key)
    },
    window: { location, addEventListener() {}, crypto },
    history: { replaceState: (_, __, url) => { location.href = url.href; } }
  });
  vm.runInContext(bootstrap, context);
  vm.runInContext(source, context);
  const run = expression => vm.runInContext(expression, context);
  run('state.isLive = true; state.workoutReadVerified = true; globalThis.messages = []; showToast = message => messages.push(message); renderAll = () => {};');
  return run;
}

test('old and new member links hide credentials immediately and restore only the matching tab', () => {
  const storage = new Map();
  const unused = () => assert.fail('No API request expected');
  const first = app(unused, undefined, storage, 'https://fixture.test/?member=QA&token=legacy&date=' + date);
  const cleanUrl = 'https://fixture.test/?date=' + date + '#name=QA';
  assert.equal(first('location.href'), cleanUrl);
  assert.equal(first('state.token'), 'legacy');
  assert.equal(first('state.selectedDate'), date);
  const reopened = app(unused, undefined, storage, cleanUrl);
  assert.equal(reopened('state.token'), 'legacy');
  const anotherMember = app(unused, undefined, storage, 'https://fixture.test/#name=Other');
  assert.equal(anotherMember('state.token'), '');
  const shared = first("memberLinkUrl(location.origin, 'QA', 'token+with&symbols')");
  assert.equal(new URL(shared).search, '');
  assert.equal(first('extractTokenValue(' + JSON.stringify(shared) + ')'), 'token+with&symbols');
  const second = app(unused, undefined, storage, shared);
  assert.equal(second('location.href'), 'https://fixture.test/#name=QA');
  assert.equal(second('state.token'), 'token+with&symbols');
});

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

test('both JSON APIs validate browser origin and content type before reading the body', async () => {
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ URL, Response, performance })
  });
  await mod.link(() => {});
  await mod.evaluate();
  for (const path of ['/api/records', '/api/apps-script']) {
    const send = (type, origin) => mod.namespace.default.fetch(new Request('https://fixture.test' + path, {
      method: 'POST', headers: { 'Content-Type': type, ...(origin ? { Origin: origin } : {}) }, body: '{'
    }), {});
    assert.equal((await send('application/json','https://other.test')).status, 403);
    assert.equal((await send('application/json','null')).status, 403);
    assert.equal((await send('text/plain','https://fixture.test')).status, 415);
    assert.equal((await send('application/json; charset=UTF-8','https://fixture.test')).status, 400);
    assert.equal((await send('application/json')).status, 400);
  }
});

test('member session survives a reload, stays bound to the link, and renews after rejection', async () => {
  const storage = new Map();
  let exchanges = 0;
  const fetch = async (_, request) => {
    const body = JSON.parse(request.body);
    if (body.action === 'memberSession') {
      exchanges++;
      return Response.json({ status: 'success', session: 'signed-' + exchanges, exp: Date.now() + 3600000 });
    }
    return body.session === 'signed-1'
      ? Response.json({ status: 'denied', code: 'session_invalid' }, { status: 403 })
      : Response.json({ status: 'success', session: body.session });
  };

  const initial = app(fetch, undefined, storage);
  assert.equal(await initial("memberSession(state.memberName, state.selectedDate)"), 'signed-1');
  assert.ok(!storage.get('fit_member_session_v1').includes('"token":"fixture"'));

  const reopened = app(fetch, undefined, storage);
  assert.equal(await reopened("memberSession(state.memberName, state.selectedDate)"), 'signed-1');
  assert.equal(exchanges, 1);
  const result = await reopened("postRecords({ action: 'read', member: state.memberName, date: state.selectedDate, session: state.session })");
  assert.equal(result.session, 'signed-2');

  const changedLink = app(fetch, undefined, storage);
  changedLink("state.token = 'different-link'");
  assert.equal(await changedLink("memberSession(state.memberName, state.selectedDate)"), 'signed-3');
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
  assert.equal(run('state.dayReadError.denied'), true);
  assert.equal(run('state.dayReadError.cached'), false);
});

test('member day retries a transient failure once and preserves the selected date', async () => {
  const calls = [];
  const run = app(async (url, request) => {
    assert.equal(url, '/api/records');
    const body = JSON.parse(request.body);
    calls.push(body.date);
    if (calls.length === 1) return Response.json({status:'error',code:'fixture_unavailable'},{status:502});
    return Response.json({nativeDaily:true,headerMessage:'recovered',routines:[]});
  });
  run("state.nativeDaily=true; state.session='fixture'; state.loading=true;");
  await run("loadMemberDateData(state.selectedDate)");
  assert.deepEqual(calls,[date,date]);
  assert.equal(run('state.selectedDate'),date);
  assert.equal(run('state.record.headerMessage'),'recovered');
  assert.equal(run('state.dayReadError'),null);
  assert.equal(run('state.mealReadVerified'),true);
});

test('member day stays unverified after a second failure and marks the matching cache read-only', async () => {
  let attempts=0;
  const run=app(async () => {
    attempts++;
    return Response.json({status:'error',code:'fixture_unavailable'},{status:503});
  });
  run(`state.nativeDaily=true; state.session='fixture'; state.workoutReadVerified=true;
    globalThis.localStorage={ getItem(key) {
      return key === 'fit_cache_v2_QA_'+state.selectedDate ? JSON.stringify({record:{headerMessage:'cached day'}}):null;
    } };`);
  await run("loadMemberDateData(state.selectedDate)");
  assert.equal(attempts,2);
  assert.equal(run('state.dayReadError.cached'),true);
  assert.equal(run('state.dayReadError.denied'),false);
  assert.equal(run('state.record.headerMessage'),'cached day');
  assert.equal(run('state.mealReadVerified || state.workoutReadVerified'),false);
});

test('cold member date reuses its authenticated record and loads optional calls after paint', async () => {
  const calls = [];
  const legacyCalls = [];
  const run = app(async (url,request)=>{
    if (url === '/api/apps-script') {
      legacyCalls.push(JSON.parse(request.body).date);
      return Response.json({ status: 'success' });
    }
    const body = JSON.parse(request.body);
    calls.push({action:body.action,session:body.session,includeDaily:body.includeDaily,date:body.date});
    if (body.action==='memberSession')
      return Response.json({
        status:'success',session:'verified',exp:Date.now()+3600000,
        daily:{headerMessage:'canonical coach note',coachFeedbackStored:true},
        legacyDaily:{routines:[{name:'latest routine'}]}
      });
    if (body.action==='read') return Response.json({headerMessage:'today first'});
    if (body.action==='memberInsights') return Response.json({status:'success',workoutDays:[body.date]});
    if (body.action==='directVideoList') return Response.json({status:'success',videos:[]});
    return Response.json({status:'success',columns:[],days:[]});
  });
  run('globalThis.frames = []; globalThis.requestAnimationFrame = cb => frames.push(cb); refreshMemberSummaries = () => {};');
  await run('loadMemberDateData(state.selectedDate)');
  assert.deepEqual(calls.map(item=>item.action),['memberSession']);
  assert.equal(calls[0].includeDaily,true);
  assert.deepEqual(legacyCalls,[]);
  assert.equal(run('state.record.headerMessage'),'canonical coach note');
  assert.equal(run('state.record.routines[0].name'),'latest routine');
  assert.equal(run('state.loading'),false);
  run('frames.shift()(); frames.shift()();');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(item=>item.action==='columnList').length,1);
  assert.equal(calls.find(item=>item.action==='columnList').date,date);
  assert.ok(calls.slice(1).every(item=>item.session==='verified'));
  await run("state.selectedDate = '2026-11-20'; loadMemberDateData(state.selectedDate)");
  assert.deepEqual(legacyCalls,['2026-11-20']);
  run('frames.shift()(); frames.shift()();');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(item=>item.action==='columnList').length,1);
  assert.equal(calls.filter(item=>item.action==='directVideoList').length,1);
  assert.equal(calls.filter(item=>item.action==='workoutHistory').length,0);
  assert.equal(run('state.workoutDays[0]'),'2026-11-20');
  await run("memberVideoVersion++; state.selectedDate = '2026-11-21'; loadMemberDateData(state.selectedDate)");
  run('frames.shift()(); frames.shift()();');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(item=>item.action==='directVideoList').length,2);
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

  calls.length = 0;
  run('state.nativeDaily = true;');
  await run("saveMealLive('QA', state.selectedDate, 'lunch', meal, '')");
  await run("saveMealLive('QA', state.selectedDate, 'lunch', meal, 'data:image/jpeg;base64,AAAA')");
  assert.deepEqual(calls.map(([url]) => url), ['/api/records', '/api/records']);
  assert.deepEqual(calls[0][1].diet, patch.diet);
  assert.deepEqual(calls[1][1].diet.lunch.photos, ['data:image/jpeg;base64,AAAA']);
});

test('coach dashboard appears before legacy links and preserves the active member list', async () => {
  let finishLegacy;
  const legacy = new Promise(resolve => { finishLegacy = resolve; });
  const run = app(async (url, request) => {
    const body = JSON.parse(request.body);
    if (body.action === 'listMembers') return legacy;
    assert.equal(url, '/api/records');
    if (body.action === 'verify') return Response.json({ status: 'success' });
    if (body.action === 'memberSession') return Response.json({ status: 'success', session: 'verified-link' });
    if (body.action === 'trainerOverview') {
      return Response.json({ status: 'success', members: [{ name: 'QA', pendingWorkout: true }] });
    }
    assert.equal(body.action, 'listMembersFast');
    return Response.json({ status: 'success', members: ['QA'], nativeMembers: ['QA'], archivedMembers: ['Archived'] });
  });
  run('closeModal = () => {};');
  const opened = await Promise.race([
    run("enterCoachWithPassword('coach-fixture', false)"),
    new Promise(resolve => setImmediate(() => resolve(false)))
  ]);
  assert.equal(opened, true);
  assert.equal(run('state.appMode'), 'coach');
  assert.equal(run('state.coachNativeOverview'), true);
  assert.equal(run('state.trainerOverview[0].pendingWorkout'), true);
  finishLegacy(Response.json({ status: 'success', members: [
    { name: 'QA', token: 'fixture-link' }, { name: 'Archived', token: 'archived-link' }
  ] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('state.trainerOverview.length'), 1);
  assert.equal(await run("resolveMemberToken('QA')"), 'fixture-link');
});

test('coach date changes request only the overview and keep the latest date, tab, filter, and links', async () => {
  const calls = [];
  let finishOlder;
  const older = new Promise(resolve => { finishOlder = resolve; });
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    if (body.date === '2026-11-20') return older;
    if (body.date === '2026-11-22') return new Response(null, { status: 403 });
    return Response.json({ status: 'success', members: [{ name: 'QA', lastDate: body.date }] });
  });
  run(`state.appMode = 'coach'; state.trainerPassword = 'coach-cookie'; state.coachNativeOverview = true;
    state.coachOverviewDate = state.selectedDate; state.coachTab = 'members'; state.coachFilter = 'diet';
    state.trainerOverview = [{ name: 'QA', token: 'fixture-link' }];`);

  const first = run("selectCoachDate('2026-11-20')");
  assert.match(run('renderCoachView()'), /현황을 불러오는 중/);
  await run("selectCoachDate('2026-11-21')");
  finishOlder(Response.json({ status: 'success', members: [{ name: 'QA', lastDate: '2026-11-20' }] }));
  await first;
  await run("selectCoachDate('2026-11-21')");

  assert.deepEqual(calls, [
    { action: 'trainerOverview', date: '2026-11-20' },
    { action: 'trainerOverview', date: '2026-11-21' }
  ]);
  assert.equal(run('state.selectedDate'), '2026-11-21');
  assert.equal(run('state.coachOverviewDate'), '2026-11-21');
  assert.equal(run('state.trainerOverview[0].lastDate'), '2026-11-21');
  assert.equal(run('state.trainerOverview[0].token'), 'fixture-link');
  assert.equal(run('state.coachTab'), 'members');
  assert.equal(run('state.coachFilter'), 'diet');

  await run("selectCoachDate('2026-11-22')");
  assert.match(run('renderCoachView()'), /코치 로그인이 필요해요/);
  assert.equal(run('state.trainerPassword'), '');
  assert.equal(run('state.trainerOverview.length'), 0);
});

test('coach overview uses a stable second sort key across record pages', async () => {
  const members = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), name: 'QA ' + (i + 1) }));
  const records = Array.from({ length: 45 }, (_, i) => {
    const recordDate = new Date(Date.parse(date) - i * 86400000).toISOString().slice(0, 10);
    return members.slice(0, -1).map(({ id }) => ({
      member_id: id, record_date: recordDate, routines: [{ completedSets: [true] }],
    }));
  }).flat();
  const pageQueries = [];
  const fetch = async url => {
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith('/fit_members')) return Response.json(members);
    if (!pathname.endsWith('/fit_daily_records')) return Response.json([]);
    const offset = Number(searchParams.get('offset'));
    pageQueries.push({ offset, order: searchParams.get('order') });
    return Response.json(records.slice(offset, offset + Number(searchParams.get('limit'))));
  };
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ URL, Request, Response, AbortSignal, TextEncoder, performance, fetch }),
  });
  await mod.link(() => {});
  await mod.evaluate();
  const response = await mod.namespace.default.fetch(new Request('https://fixture.test/api/records', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'trainerOverview', date, password: 'coach-fixture' }),
  }), { SUPABASE_URL: 'https://fixture-db.supabase.co', SUPABASE_SECRET_KEY: 'fixture', TRAINER_PASSWORD: 'coach-fixture' });
  assert.equal(response.status, 200);
  const overview = await response.json();
  assert.equal(overview.members.length, 25);
  assert.equal(overview.members[0].weeklyWorkoutDays, 7);
  assert.equal(overview.members.at(-1).weeklyWorkoutDays, 0);
  assert.deepEqual(pageQueries, [
    { offset: 0, order: 'record_date.desc,member_id.asc' },
    { offset: 1000, order: 'record_date.desc,member_id.asc' },
  ]);
});

test('coach replaces a rejected cached link with a verified existing link', async () => {
  const calls = [];
  let validReplacement = true;
  const run = app(async (url, request) => {
    const body = JSON.parse(request.body);
    calls.push([url, body.action]);
    if (url === '/api/apps-script') {
      assert.equal(body.action, 'getMemberLink');
      return Response.json({status:'success',url:'https://fixture.test/?name=QA&token=current-link'});
    }
    assert.equal(body.action, 'memberSession');
    assert.equal(body.member, 'QA');
    return body.token === 'current-link' && validReplacement
      ? Response.json({status:'success',session:'checked'})
      : Response.json({status:'denied',code:'unauthorized'},{status:403});
  });
  run("state.appMode='coach'; state.trainerPassword='coach-fixture'; state.trainerOverview=[{name:'QA',token:'old-link'}];");
  assert.equal(await run("resolveMemberToken('QA')"),'current-link');
  assert.equal(run('state.trainerOverview[0].token'),'current-link');
  assert.deepEqual(calls.map(([,action])=>action),['memberSession','getMemberLink','memberSession']);
  validReplacement = false;
  assert.equal(await run("resolveMemberToken('QA')"),'');
});

test('coach starts the clipboard write during the tap and confirms only after it succeeds', async () => {
  const run = app(() => assert.fail('No API request expected'));
  const copy = run(`
    state.appMode = 'coach';
    state.trainerPassword = 'fixture-coach';
    let resolveToken, finishClipboard, copiedLink;
    const pendingToken = new Promise(resolve => { resolveToken = resolve; });
    const clipboardReady = new Promise(resolve => { finishClipboard = resolve; });
    resolveMemberToken = () => pendingToken;
    globalThis.ClipboardItem = class { constructor(data) { this.data = data; } };
    navigator.clipboard = {
      write([item]) {
        copiedLink = item.data['text/plain'].then(blob => blob.text());
        return Promise.all([copiedLink, clipboardReady]);
      }
    };
    copyMemberLink('QA');
  `);
  assert.equal(run('Boolean(copiedLink)'), true);
  run("resolveToken('verified-fixture-token')");
  const link = new URL(await run('copiedLink'));
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), 'verified-fixture-token');
  assert.equal(run("messages.some(message => message.includes('복사했어요'))"), false);
  run('finishClipboard()');
  await copy;
  assert.equal(run('messages.at(-1)'), '회원 전용 링크를 복사했어요.');
});

test('coach shows the selectable link when clipboard writes fail and can retry with a tap', async () => {
  const run = app(() => assert.fail('No API request expected'));
  await run(`
    state.appMode = 'coach';
    state.trainerPassword = 'fixture-coach';
    resolveMemberToken = async () => 'verified-fixture-token';
    globalThis.ClipboardItem = class { constructor() {} };
    navigator.clipboard = { write: async () => { throw new Error('User activation required'); } };
    let fallbackTitle;
    openModal = title => { fallbackTitle = title; };
    let retryCopy;
    document.getElementById('member-link-copy-retry').addEventListener = (_, callback) => { retryCopy = callback; };
    copyMemberLink('QA');
  `);
  assert.equal(run('fallbackTitle'), '회원 전용 링크');
  assert.equal(run("messages.some(message => message.includes('복사했어요'))"), false);
  const shownLink = new URL(run("document.getElementById('member-link-copy-value').value"));
  assert.equal(new URLSearchParams(shownLink.hash.slice(1)).get('token'), 'verified-fixture-token');
  await run(`
    let retriedLink;
    navigator.clipboard.writeText = async link => { retriedLink = link; };
    retryCopy();
  `);
  assert.equal(run('retriedLink'), shownLink.href);
  assert.equal(run("document.getElementById('member-link-copy-value').value"), '');
  assert.equal(run('messages.at(-1)'), '회원 전용 링크를 복사했어요.');
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

test('coach detail loads the native PT week with one compact request', async () => {
  const calls = [];
  const run = app(async (url, request) => {
    assert.equal(url, '/api/records');
    const body = JSON.parse(request.body);
    calls.push(body.action);
    if (body.action === 'workoutHistory') return Response.json({ status: 'success', previous: {} });
    if (body.action === 'coachPtWeek') {
      const schedules = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [
        `2026-11-${15 + i}`, { ptScheduled: true, ptTime: i === 1 ? '20:00' : '19:00' }
      ]));
      return Response.json({ status: 'success', schedules });
    }
    assert.equal(body.date, '2026-11-18');
    return Response.json({ nativeDaily: true, ptScheduled: true, ptTime: '19:00' });
  });
  run("state.appMode='coach'; state.trainerPassword='coach-fixture';");
  const result = await run("fetchMemberForCoach('target','2026-11-18')");
  assert.equal(result.daily.ptTime, '19:00');
  const week = await result.weekPtRequest;
  assert.equal(week['2026-11-16'].ptTime, '20:00');
  assert.equal(week['2026-11-18'], undefined);
  assert.deepEqual(calls.sort(), ['coachPtWeek', 'read', 'workoutHistory']);
});

test('PT week API is coach-only and projects just this member’s seven schedule dates', async () => {
  let scheduleRequests = 0;
  const fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/fit_members')) {
      assert.equal(parsed.searchParams.get('name'), 'eq.target');
      return Response.json([{ id: 'fixture-id', worker_link_sha256: 'fixture-digest', is_archived: false }]);
    }
    assert.ok(parsed.pathname.endsWith('/fit_daily_records'));
    assert.equal(parsed.searchParams.get('member_id'), 'eq.fixture-id');
    assert.deepEqual(parsed.searchParams.getAll('record_date'), ['gte.2026-11-29', 'lte.2026-12-05']);
    assert.equal(parsed.searchParams.get('select'), 'record_date,pt_scheduled:data->ptScheduled,pt_time:data->>ptTime');
    scheduleRequests++;
    return Response.json([{ record_date: '2026-12-02', pt_scheduled: true, pt_time: ' 18:30 ' }]);
  };
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ fetch, URL, Response, Request, Headers, TextEncoder, TextDecoder, AbortSignal, performance, crypto, btoa, atob })
  });
  await mod.link(() => {});
  await mod.evaluate();
  const env = { TRAINER_PASSWORD: 'coach-fixture', MEMBER_SESSION_SECRET: 'fixture-member-session-key-for-tests',
    SUPABASE_URL: 'https://fixture-db.supabase.co', SUPABASE_SECRET_KEY: 'fixture' };
  const dispatch = auth => mod.namespace.default.fetch(new Request('https://fixture.test/api/records', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'coachPtWeek', member: 'target', date: '2026-12-01', ...auth })
  }), env);
  assert.equal((await dispatch({ session: 'fixture-member-session' })).status, 403);
  assert.equal((await dispatch({ token: 'fixture-member-link' })).status, 403);
  assert.equal(scheduleRequests, 0);
  const response = await dispatch({ password: 'coach-fixture' });
  assert.equal(response.status, 200);
  const { schedules } = await response.json();
  assert.equal(Object.keys(schedules).length, 7);
  assert.deepEqual(schedules['2026-12-02'], { ptScheduled: true, ptTime: '18:30' });
  assert.deepEqual(schedules['2026-11-29'], { ptScheduled: false, ptTime: '' });
  assert.equal(scheduleRequests, 1);
});

test('coach PT times are edited, saved, and read by the selected date', async () => {
  const first = '2026-11-16';
  const second = '2026-11-18';
  const added = '2026-11-20';
  const legacy = new Map([
    [first, { ptScheduled: true, ptTime: '18:00', routines: [{ name: '스쿼트' }] }],
    [second, { ptScheduled: true, ptTime: '20:00' }]
  ]);
  const writes = [];
  let releaseWeek;
  const week = new Promise(resolve => { releaseWeek = resolve; });
  const run = app(async (url, request) => {
    const body = JSON.parse(request.body);
    if (url === '/api/records') {
      const data = body.date === first ? { ptScheduled: true, ptTime: '16:00' } : {};
      return Response.json({ status: 'success', ...data });
    }
    if (body.action === 'read') {
      if (body.date !== second) await week;
      return Response.json({ status: 'success', data: legacy.get(body.date) || {} });
    }
    writes.push(body);
    const patch = body.patch || body.data;
    if (body.date === added && body.action === 'patchData') {
      // Simulates an older Apps Script acknowledging a patch that omitted PT fields.
      return Response.json({ status: 'success' });
    }
    legacy.set(body.date, { ...legacy.get(body.date), ...patch });
    return Response.json({ status: 'success' });
  });
  run(`state.appMode = 'coach'; state.trainerPassword = 'coach-fixture';
    globalThis.nodes = new Map();
    globalThis.node = id => {
      if (!nodes.has(id)) nodes.set(id, {
        isConnected: true, dataset: {}, value: '', disabled: false,
        classList: { add() {}, remove() {}, contains() { return true; }, toggle() {} },
        addEventListener(event, handler) { this[event] = handler; },
        setAttribute() {}, querySelector: node, querySelectorAll() { return []; }
      });
      return nodes.get(id);
    };
    document.getElementById = node;
    document.querySelectorAll = () => [];
    openModal = (_, content) => { globalThis.modalHtml = content; };
    hydrateDirectImages = () => {};
    Object.defineProperty(node('cd-pt-schedule'), 'outerHTML', {
      set(html) { globalThis.scheduleHtml = html; }
    });
    node('cd-pt-schedule').querySelectorAll = () => [node('add-day')];
    node('add-day').dataset.ptday = '${added}';
  `);
  await run(`openCoachDetailSheet('target', '${second}')`);
  assert.match(run('modalHtml'), /이번 주 일정을 불러오는 중/);
  assert.match(run('modalHtml'), new RegExp(`data-pt-time="${second}" value="20:00"`));
  releaseWeek();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(run('scheduleHtml'), new RegExp(`data-pt-time="${first}" value="18:00"`));
  assert.match(run('scheduleHtml'), new RegExp(`data-pt-time="${second}" value="20:00"`));
  run(`node('cd-pt-schedule').input({ target: { dataset: { ptTime: '${second}' }, value: ' 20:30 ' } });
    node('add-day').click();
    node('cd-pt-schedule').input({ target: { dataset: { ptTime: '${added}' }, value: '17:15' } });`);
  await run("node('cd-save-pt-days').click()");
  assert.deepEqual(writes.map(({ date, patch, data }) => [date, patch || data]), [
    [second, { ptScheduled: true, ptTime: '20:30' }],
    [added, { ptScheduled: true, ptTime: '17:15' }],
    [added, { ptScheduled: true, ptTime: '17:15' }]
  ]);
  assert.ok(writes.every(write => write.member === 'target' && write.password === 'coach-fixture'));
  assert.deepEqual(legacy.get(first).routines, [{ name: '스쿼트' }]);
  await run("node('cd-save-pt-days').click()");
  assert.equal(writes.length, 3);

  run("node('add-day').click()");
  await run("node('cd-save-pt-days').click()");
  assert.deepEqual(writes.at(-1).data, { ptScheduled: false, ptTime: '' });
  assert.equal(legacy.get(added).ptScheduled, false);

  run("state.appMode = 'member'; state.trainerPassword = ''; state.session = 'member-fixture'; state.sessionExpires = Date.now() + 3600000; state.memberTab = 'lesson';");
  for (const [day, time] of [[first, '18:00'], [second, '20:30']]) {
    await run(`state.selectedDate = '${day}'; loadMemberDateData(state.selectedDate)`);
    assert.equal(run('state.record.ptTime'), time);
    assert.match(run('renderMemberView()'), new RegExp(`${time} 수업`));
  }
  await run(`state.selectedDate = '${added}'; loadMemberDateData(state.selectedDate)`);
  assert.equal(run('state.record.ptScheduled'), false);
  assert.equal(run('state.record.ptTime'), '');
});

test('a failed set write is restored after reload without replacing coach routine edits', async () => {
  const store = new Map();
  const offline = app(async () => { throw Error('offline'); }, undefined, store);
  offline("state.record.routines=[{id:'exercise',routineType:'homework',sets:2,completedSets:[true,false]}]; enqueueWorkoutSave(state.record.routines[0], [0])");
  await offline("retryWorkoutSave(); flushWorkoutSave(workoutSaveJobs.values().next().value)");
  assert.equal([...store.keys()].filter(key => key.startsWith('fit_workout_draft_v1_')).length, 1);
  const calls = [];
  const reopened = app(async (_, request) => {
    calls.push(JSON.parse(request.body));
    return Response.json({ status: 'success' });
  }, undefined, store);
  reopened("state.record.routines=[{id:'exercise',routineType:'homework',sets:2,weight:40,completedSets:[false,true]}]; restoreWorkoutSave()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopened('state.record.routines[0].completedSets[0]'), true);
  assert.equal(reopened('state.record.routines[0].weight'), 40);
  assert.equal(reopened('state.record.routines[0].completedSets[1]'), true);
  assert.equal(calls[0].action, 'setProgressBatch');
  assert.deepEqual(calls[0].changes, [{ id: 'exercise', index: 0, checked: true }]);
  assert.equal(calls[0].date, date);
  assert.ok([...store.keys()].every(key => !key.startsWith('fit_workout_draft_v1_')));
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

test('a combined member session and daily read performs one account lookup and protects archived members', async () => {
  const calls = [];
  let accepted = true;
  let archived = false;
  let rpcAvailable = true;
  let native = false;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('fixture'))),
    byte => byte.toString(16).padStart(2,'0')).join('');
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'script.google.com') {
      calls.push('token');
      return Response.json(accepted ? { routines:[{name:'fresh routine'}] } : {status:'denied'});
    }
    assert.equal(parsed.hostname, 'fixture-db.supabase.co');
    calls.push(parsed.pathname.split('/').at(-1));
    if (parsed.pathname.endsWith('/fit_member_day_snapshot')) {
      assert.equal(parsed.searchParams.get('p_name'), 'QA');
      assert.equal(parsed.searchParams.get('p_date'), date);
      return rpcAvailable
        ? Response.json({member:{id:'fixture-member',is_archived:archived,worker_link_sha256:native?digest:null},daily:[{data:{headerMessage:'fixture'}}],photos:[],feedback:[]})
        : Response.json({code:'PGRST202'}, {status:404});
    }
    if (parsed.pathname.endsWith('/fit_members')) return Response.json([{ id:'fixture-member', is_archived:archived, worker_link_sha256:native?digest:null }]);
    if (parsed.pathname.endsWith('/fit_columns')) {
      assert.equal(parsed.searchParams.get('status'), 'eq.published');
      return Response.json([{ id: 'fixture-column', title: '오늘의 매거진' }]);
    }
    if (parsed.pathname.endsWith('/fit_worker_save_day')) {
      assert.equal(new Headers(options.headers).get('x-fit-record-writer'), 'fit-connect-worker');
      const body = JSON.parse(options.body);
      assert.equal(body.p_member_id,'fixture-member');
      assert.equal(body.p_date,date);
      assert.equal(body.p_action,'setProgressBatch');
      assert.equal(body.p_trainer,false);
      return Response.json({});
    }
    assert.equal(parsed.searchParams.get('member_id'), 'eq.fixture-member');
    assert.equal(parsed.searchParams.get('record_date'), 'eq.' + date);
    return Response.json(parsed.pathname.endsWith('/fit_daily_records') ? [{ data:{ headerMessage:'fixture' } }] : []);
  };
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ fetch, URL, Response, Request, Headers, TextEncoder, TextDecoder, AbortSignal, performance, crypto, btoa, atob })
  });
  await mod.link(() => {});
  await mod.evaluate();
  const dispatch = (token='fixture', path='records', extra={}) => mod.namespace.default.fetch(new Request('https://fixture.test/api/'+path, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:'memberSession', includeDaily:true, member:'QA', date, token, ...extra})
  }), { SUPABASE_URL:'https://fixture-db.supabase.co', SUPABASE_SECRET_KEY:'fixture', MEMBER_SESSION_SECRET:'fixture-session-key-for-local-tests' });

  const response = await dispatch();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.session);
  assert.equal(data.daily.headerMessage, 'fixture');
  assert.equal(data.legacyDaily.routines[0].name, 'fresh routine');
  assert.deepEqual(calls, ['fit_member_day_snapshot','token']);

  calls.length = 0;
  rpcAvailable = false;
  const fallback = await dispatch();
  assert.equal(fallback.status, 200);
  assert.equal((await fallback.json()).daily.headerMessage, 'fixture');
  assert.deepEqual(calls.slice(0,3), ['fit_member_day_snapshot','fit_members','token']);
  assert.ok(calls.includes('fit_daily_records'));
  rpcAvailable = true;

  calls.length = 0;
  archived = true;
  const denied = await dispatch();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'member_archived');
  assert.deepEqual(calls, ['fit_member_day_snapshot']);

  calls.length = 0;
  archived = false;
  accepted = false;
  const invalid = await dispatch();
  assert.equal(invalid.status, 403);
  assert.equal((await invalid.json()).code, 'unauthorized');
  assert.deepEqual(calls, ['fit_member_day_snapshot','token']);

  calls.length = 0;
  native = true;
  const fast = await dispatch();
  assert.equal(fast.status, 200);
  const fastBody = await fast.json();
  assert.equal(fastBody.daily.nativeDaily,true);
  assert.ok(!JSON.stringify(fastBody).includes(digest));
  assert.deepEqual(calls,['fit_member_day_snapshot']);

  calls.length = 0;
  const magazine = await dispatch('fixture', 'records', {action:'columnList', date:undefined});
  assert.equal(magazine.status, 200);
  assert.equal((await magazine.json()).columns[0].id, 'fixture-column');
  assert.equal((await dispatch('wrong', 'records', {action:'columnList', date:undefined})).status, 403);

  calls.length = 0;
  assert.equal((await dispatch('wrong-fixture')).status,403);
  assert.deepEqual(calls,['fit_member_day_snapshot']);

  calls.length = 0;
  const update = {action:'setProgressBatch',changes:[{id:'h',index:0,checked:true}]};
  assert.equal((await dispatch('wrong-fixture','apps-script', update)).status,403);
  assert.deepEqual(calls,['fit_members']);
  calls.length = 0;
  const write = await dispatch('fixture','apps-script',update);
  assert.equal(write.status,200);
  assert.equal((await write.json()).status,'success');
  assert.deepEqual(calls,['fit_members','fit_worker_save_day']);
});

test('Worker retries a check-in write conflict and preserves intervening record fields', async () => {
  const originalVersion = '2026-11-19T04:00:00.000Z';
  const currentVersion = '2026-11-19T04:00:01.000Z';
  let reads = 0;
  let patches = 0;
  let memberLookups = 0;
  const fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.pathname.endsWith('/fit_members')) {
      memberLookups++;
      return Response.json([{ id: 'test-member' }]);
    }
    if (init.method !== 'PATCH') {
      reads++;
      return Response.json([{ id: 'row', updated_at: reads === 1 ? originalVersion : currentVersion,
        data: { diet: { water: reads === 1 ? 500 : 1000 }, dailyCheckin: { diet: 'done' } } }]);
    }
    patches++;
    assert.equal(new Headers(init.headers).get('x-fit-record-writer'), 'fit-connect-worker');
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dailyCheckin', password: 'fixture', member: 'QA', date, checkin: { mood: 'good' } })
  }), { TRAINER_PASSWORD: 'fixture', SUPABASE_URL: 'https://storage-fixture.supabase.co', SUPABASE_SECRET_KEY: 'fixture' });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(patches, 2);
  assert.equal(data.diet.water, 1000);
  assert.equal(data.dailyCheckin.diet, 'done');
  assert.equal(data.dailyCheckin.mood, 'good');
  assert.equal(memberLookups, 1);
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
    if (pathname.endsWith('/fit_member_day_snapshot')) {
      return Response.json({member:{id:memberId,is_archived:false},daily:row?[row]:[],photos:photo?[photo]:[],feedback:[]});
    }
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
    assert.equal(new Headers(init.headers).get('x-fit-record-writer'), 'fit-connect-worker');
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, password: 'fixture', member: 'QA Diet', date, ...extra })
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
      this.audio = this.metadata.audio ? [{ getCodec: async () => this.metadata.audioCodec || 'aac' }] : [];
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
      async init({ input, output, video, audio }) {
        converted++;
        const [track] = await input.getAudioTracks();
        const sourceCodec = await track.getCodec();
        const audioOptions = await audio(track);
        assert.deepEqual(JSON.parse(JSON.stringify(audioOptions)), sourceCodec === 'aac'
          ? { codec: 'aac' } : { codec: 'aac', bitrate: 128_000 });
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
  const reasons = [];
  const onFallback = reason => reasons.push(reason);
  assert.equal(await compress(hdr, signal, () => {}, 0, { onFallback }), hdr);
  const unsupported = { ...sourceVideo, metadata: { ...sourceVideo.metadata, supported: false } };
  assert.equal(await compress(unsupported, signal, () => {}), unsupported);
  assert.equal(converted, 0);
  const progress = [];
  const estimates = [];
  const result = await compress(sourceVideo, signal, percent => progress.push(percent), 0, {
    onEstimate: size => estimates.push(size)
  });
  assert.ok(estimates[0] < sourceVideo.size * 0.7);
  assert.equal(result.type, 'video/mp4');
  assert.equal(result.size, 12_000_000);
  assert.deepEqual(progress, [50]);
  const nonAac = { ...sourceVideo, metadata: { ...sourceVideo.metadata, audioCodec: 'opus' } };
  assert.equal((await compress(nonAac, signal, () => {})).type, 'video/mp4');
  stripAudio = true;
  assert.equal(await compress(sourceVideo, signal, () => {}, 0, { onFallback }), sourceVideo);
  assert.deepEqual(reasons, ['hdr', 'verification']);
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

test('large videos can upload with or without compression and report the active limit', async () => {
  const calls = [];
  let legacy = false;
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    if (legacy && body.action === 'directVideoBegin') {
      return Response.json({ code: 'video_size_limit' }, { status: 413 });
    }
    return Response.json({ status: 'success', url: 'https://storage.fixture.test/put' });
  });
  const upload = "uploadDirectVideoFile({name:'original.mov',size:64_000_000},'QA','fixture','',null)";
  run("state.session='valid'; xhrVideoTransfer=async()=>({ok:true}); prepareDirectVideo=async()=>({name:'compact.mp4',type:'video/mp4',size:15_000_000});");
  await run(upload);
  assert.equal(calls[0].size, 15_000_000);
  run("prepareDirectVideo=async file=>file;");
  await run(upload);
  assert.equal(calls[2].size, 64_000_000);
  await assert.rejects(run("uploadDirectVideoFile({name:'original.mov',size:100_000_001},'QA','fixture','',null)"), /영상은 100MB까지/);
  assert.equal(calls.length, 4);
  legacy = true;
  await assert.rejects(run(upload), /현재 저장소는 영상 50MB까지/);
});

test('workout points stay stable and do not repeat through the end of 2027', () => {
  const run = app(async () => Response.json({}));
  const monday = "getDailyWorkoutPoint('2026-11-23')";
  assert.equal(run(monday).day, '월요일');
  assert.equal(run(monday).note, run(monday).note);
  assert.notEqual(run(monday).note, run("getDailyWorkoutPoint('2026-12-21').note"));
  const scheduled = run(`JSON.stringify(Array.from({length: 405}, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 22 + index)).toISOString().slice(0, 10);
    return getDailyWorkoutPoint(date).note;
  }))`);
  const points = JSON.parse(scheduled);
  assert.ok(points.every(point => point.trim().length > 0));
  assert.equal(new Set(points).size, points.length);
  assert.equal(run("getDailyWorkoutPoint('2026-11-21').note"), '');
  assert.equal(run("getDailyWorkoutPoint('2028-01-01').note"), '');
});

test('member home renders both historical dates and dates with a scheduled workout point', () => {
  const run = app(async () => Response.json({}));
  run("state.memberTab='report'; state.loading=false; state.record.headerMessage=''; state.record.feedback={};");
  assert.match(run("state.selectedDate='2026-11-19'; renderMemberView()"), /목요일/);
  assert.match(run('renderMemberView()'), /수업일지에서 운동 기록을 확인해 보세요/);
  run("state.selectedDate='2026-11-23'; state.record.headerMessage='코치가 남긴 운동 피드백';");
  const today = run('renderMemberView()');
  assert.match(today, /코치가 남긴 운동 피드백/);
  assert.match(today, /월요일 운동 포인트/);
  assert.ok(today.includes(run("getDailyWorkoutPoint('2026-11-23').note")));
  run("state.selectedDate='2026-12-08'; state.record.headerMessage='';");
  const dietDay = run('renderMemberView()');
  assert.match(dietDay, /화요일 생활 다이어트 팁/);
  assert.match(dietDay, /외식 약속이 있는 날에도 앞 끼니는 평소처럼/);
  assert.ok(!dietDay.includes(run("getDailyWorkoutPoint(state.selectedDate).note")));

  run("state.record.feedback.workout='개인 운동 피드백';");
  const withFeedback = run('renderMemberView()');
  assert.match(withFeedback, /개인 운동 피드백[\s\S]*화요일 생활 다이어트 팁/);
  assert.match(run("state.selectedDate='2026-12-09'; renderMemberView()"), /수요일 운동 포인트/);
  const nextDietDay = run("state.selectedDate='2026-12-10'; renderMemberView()");
  assert.match(nextDietDay, /목요일 생활 다이어트 팁/);
  assert.doesNotMatch(nextDietDay, /외식 약속이 있는 날에도 앞 끼니는 평소처럼/);
});

test('PT lessons are complete and read-only while personal workouts retain set controls', () => {
  const run = app(async () => Response.json({}));
  run(`state.memberTab='lesson'; state.lessonView='today'; state.loading=false;
    state.record.routines=[{id:'pt', name:'PT 기록', sets:2, routineType:'pt', completedSets:[false, false]},
      {id:'legacy', name:'이전 수업', sets:3}];`);
  const ptOnly = run('renderMemberView()');
  assert.match(ptOnly, /수업 완료/);
  assert.match(ptOnly, /오늘 운동 종목 \(2\/2\)/);
  assert.doesNotMatch(ptOnly, /class="routine-(?:set-)?toggle|workout-save-status/);
  assert.doesNotMatch(ptOnly, /모두 체크/);

  run("state.record.routines.push({id:'homework',name:'개인운동',sets:3,routineType:'homework',completedSets:[true,false,false]});");
  const combined = run('renderMemberView()');
  assert.match(combined, /data-ridx="2" class="routine-toggle /);
  assert.match(combined, /data-set-ridx="2" data-set-idx="0"/);
  assert.doesNotMatch(combined, /data-set-ridx="[01]"/);
  assert.equal(run("enqueueWorkoutSave(state.record.routines[0],[0]); workoutSaveJobs.size"), 0);
});

test('coach video management fetches ten videos from the selected day in Korea time', async () => {
  const calls = [];
  const context = vm.createContext({
    URL, TextEncoder, TextDecoder, crypto, Headers, Response, Request, AbortSignal, performance,
    setTimeout, clearTimeout, console,
    fetch: async url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/rest/v1/fit_members') return Response.json([{ id: 'test-member' }]);
      assert.equal(parsed.pathname, '/rest/v1/fit_direct_videos');
      calls.push(parsed.searchParams);
      return Response.json(Array.from({ length: parsed.searchParams.has('offset') ? 11 : 2 }, (_, i) => ({
        id: 'video-' + i, name: 'Video ' + i, mime: 'video/mp4'
      })));
    }
  });
  const mod = new vm.SourceTextModule(workerSource, { context });
  await mod.link(() => assert.fail('Unexpected module dependency'));
  await mod.evaluate();
  const env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'test-only', TRAINER_PASSWORD: 'coach-fixture' };
  const list = details => mod.namespace.default.fetch(new Request('https://fixture.test/api/records', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'directVideoList', member: 'Test member', password: 'coach-fixture', date, ...details
    })
  }), env);
  const first = await (await list({ page: 0 })).json();
  assert.equal(first.videos.length, 10);
  assert.equal(first.hasNext, true);
  assert.deepEqual(calls[0].getAll('created_at'), ['gte.2026-11-18T15:00:00.000Z', 'lt.2026-11-19T15:00:00.000Z']);
  assert.equal(calls[0].get('member_id'), 'eq.test-member');
  assert.equal(calls[0].get('limit'), '11');
  await list({ page: 5 });
  assert.equal(calls[1].get('offset'), '50');
  assert.equal((await list({ page: -1 })).status, 400);
  const legacy = await (await list({})).json();
  assert.equal(legacy.videos.length, 2);
  assert.equal(calls[2].has('created_at'), false);
});


test('quick registration uploads video and releases its lock on failure', async () => {
  const start = source.indexOf('async upload(file, member, exercise, upload) {');
  const end = source.indexOf('onSaved(date)', start);
  assert.ok(start >= 0 && end > start);
  let attempts = 0;
  const { upload, isBusy } = vm.runInNewContext(`
    let videoUploadInFlight = false;
    const requireCoach = () => {};
    const adapter = { ${source.slice(start, end)} };
    ({ upload: adapter.upload, isBusy: () => videoUploadInFlight });
  `, {
    async uploadDirectVideoFile(file, member, token, exercise, progress) {
      attempts++;
      if (attempts === 1) throw new Error('network failure');
      progress(50);
      return 'direct:test';
    }
  });
  const progress = [];
  const options = { onStage: (label, percent) => progress.push(percent) };
  await assert.rejects(upload({}, '테스트회원', '숄더 프레스', options), /network failure/);
  assert.equal(isBusy(), false);
  assert.equal(await upload({}, '테스트회원', '숄더 프레스', options), 'direct:test');
  assert.deepEqual(progress, [50]);
  assert.equal(isBusy(), false);
});


test('quick registration accepts informal Korean set notation safely', async () => {
  const { parseWorkout } = await import('./cloudflare-assets/fit-coach-quick-register.mjs');
  const now = new Date('2026-11-24T15:10:00Z');
  const names = ['테스트회원', '테스트회원둘'];
  const parse = (text) => parseWorkout(text, now, names);
  const base = parse('테스트회원 오늘 수업. 숄더 프레스 15kg 15회 4세트');
  for (const line of [
    '테스트회원 숄더 프레스 15키로 15번 4셋',
    '테 스트 회원 숄더 프레스 15 15 4',
    '테스트회원님 숄더 프레스 15x15x4'
  ]) {
    const workout = parse(line);
    assert.equal(workout.member, base.member);
    assert.equal(workout.date, base.date);
    assert.deepEqual(workout.exercises, base.exercises);
  }
  assert.equal(parse('어제, 테스트회원둘 숄더프레스 15 15 4').member, '테스트회원둘');
  assert.equal(parse('테스트회원 11/18 푸시업 맨몸 12 3').date, '2026-11-18');
  assert.equal(parse('테스트회원 숄더프레스 15회 4세트').exercises[0].sets[0].weightMissing, true);
  assert.equal(parse('테스트회원 숄더 프레스 15kg 15회 4세트, 영상은 숄더프레스').videoExercise, '숄더 프레스');
  assert.throws(() => parse('다른회원 숄더프레스 15 15 4'), /회원 이름/);
  assert.throws(() => parse('테스트회원 숄더프레스 -15kg 15회 4세트'));
  assert.throws(() => parse('테스트회원 숄더프레스 15kg 15회 4.5세트'));
  assert.throws(() => parseWorkout('테스트회원 스쿼트 40 10 3', now, ['테스트회원', '테 스트 회원']), /같은 회원/);
});


test('video upload reuses preparation started before save and reports transfer size', async () => {
  const start = source.indexOf('async function uploadDirectVideoFile(');
  const end = source.indexOf('function applyCachedMemberData', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const original = { size: 4_200_000, name: 'test.mov', type: 'video/quicktime' };
  const prepared = { size: 2_100_000, name: 'test.mp4', type: 'video/mp4' };
  let time = 0;
  const upload = vm.runInNewContext(source.slice(start, end) + '\n uploadDirectVideoFile', {
    performance: { now: () => ++time },
    state: { trainerPassword: 'coach-cookie' },
    normalizeVideoMime: (file) => file.type,
    makeUuidV4: () => 'test-video',
    MAX_VIDEO_UPLOAD_BYTES: 100_000_000,
    videoSizeLabel: String,
    prepareDirectVideo() { assert.fail('prepared video must not be encoded a second time'); },
    async postRecords(request) {
      calls.push(request.action);
      if (request.action === 'directVideoBegin') {
        assert.equal(request.size, prepared.size);
        return { status: 'success', url: 'https://example.test/put', storage: 'r2', partBytes: 6 * 1024 * 1024 };
      }
      return { status: 'success' };
    },
    async xhrVideoTransfer(url, file) {
      assert.equal(file, prepared);
      calls.push('transfer');
      return { ok: true };
    }
  });
  const job = { date: '2026-11-25', prepared: Promise.resolve({ file: prepared }) };
  assert.equal(await upload(original, '테스트회원', '', '스쿼트', undefined, job), 'direct:test-video');
  assert.deepEqual(calls, ['directVideoBegin', 'transfer', 'directVideoFinish']);
  assert.equal(job.timing.originalBytes, original.size);
  assert.equal(job.timing.sentBytes, prepared.size);
  assert.ok(job.timing.transfer > 0);
});


test('reissued member links expire and replace both the previous token and its sessions', async () => {
  const name = 'Fixture member';
  const oldToken = 'fixture-old-link';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(oldToken)));
  const account = { id: 'fixture-id', is_archived: false, worker_link_generation: null, worker_link_expires_at: null,
    worker_link_sha256: Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') };
  let writes = 0;
  const db = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'link-fixture.supabase.co');
    if (parsed.pathname.endsWith('/fit_members')) {
      if (options.method === 'PATCH') {
        const patch = JSON.parse(options.body);
        assert.equal(parsed.searchParams.get('is_archived'), 'eq.false');
        assert.equal(parsed.searchParams.get('worker_link_generation'),
          account.worker_link_generation ? 'eq.' + account.worker_link_generation : 'is.null');
        assert.equal(patch.access_token_hash, null);
        assert.ok(Date.parse(patch.worker_link_expires_at) > Date.now());
        writes++;
        Object.assign(account, patch);
        return Response.json([account]);
      }
      return Response.json(parsed.searchParams.get('name') === 'eq.' + name ? [account] : []);
    }
    if (parsed.pathname.endsWith('/fit_columns')) return Response.json([]);
    assert.fail('Unexpected database route ' + parsed.pathname);
  };
  const mod = new vm.SourceTextModule(workerSource, {
    context: vm.createContext({ fetch: db, URL, Response, Request, Headers, TextEncoder, TextDecoder, AbortSignal,
      performance, crypto, btoa, atob })
  });
  await mod.link(() => {});
  await mod.evaluate();
  const origin = 'https://fit-fixture.test';
  const env = { SUPABASE_URL: 'https://link-fixture.supabase.co', SUPABASE_SECRET_KEY: 'fixture',
    MEMBER_SESSION_SECRET: 'fixture-member-link-secret-for-testing-only', TRAINER_PASSWORD: 'coach-fixture' };
  const send = (path, payload, cookie) => mod.namespace.default.fetch(new Request(origin + '/api/' + path, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ date, ...payload })
  }), env);
  const authenticate = token => send('records', { action: 'memberSession', member: name, token });
  const initial = await authenticate(oldToken);
  assert.equal(initial.status, 200);
  const oldSession = (await initial.json()).session;
  const denied = await send('records', { action: 'memberLinkRotate', name, member: name, session: oldSession });
  assert.equal(denied.status, 403);
  assert.equal(writes, 0);
  const login = await send('records', { action: 'verify', password: 'coach-fixture' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const rotated = await send('records', { action: 'memberLinkRotate', name }, cookie);
  assert.equal(rotated.status, 200);
  const current = await rotated.json();
  assert.equal(writes, 1);
  assert.match(current.token, /^fc2_/);
  assert.notEqual(current.token, oldToken);
  assert.equal((await authenticate(oldToken)).status, 403);
  assert.equal((await send('apps-script', { action: 'read', member: name, token: oldToken })).status, 403);
  assert.equal((await send('records', { action: 'columnList', member: name, session: oldSession })).status, 403);
  const restored = await send('apps-script', { action: 'getMemberLink', name }, cookie);
  assert.equal((await restored.json()).token, current.token);
  const renewed = await authenticate(current.token);
  assert.equal(renewed.status, 200);
  const activeSession = (await renewed.json()).session;
  assert.equal((await send('records', { action: 'columnList', member: name, session: activeSession })).status, 200);
  assert.equal((await send('records', { action: 'columnList', member: 'Different member', session: activeSession })).status, 403);
  account.worker_link_expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await authenticate(current.token);
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, 'link_expired');
  assert.equal((await send('records', { action: 'columnList', member: name, session: activeSession })).status, 403);
  const expiredLink = await send('apps-script', { action: 'getMemberLink', name }, cookie);
  assert.deepEqual(await expiredLink.json(), { status: 'success', code: 'link_expired' });
});
