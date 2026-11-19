import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./cloudflare-assets/v2.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace('    initLiveMemberData();\n', '');
const workerSource = fs.readFileSync(new URL('./cloudflare-worker.js', import.meta.url), 'utf8');
const date = '2026-11-19';

function app(fetch, query = '&date=' + date) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        addEventListener() {}, querySelectorAll() { return []; }, replaceChildren() {},
        classList: { add() {}, remove() {} }, style: {}
      });
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    URLSearchParams, fetch, document,
    window: { location: { protocol: 'https:', hostname: 'fixture.test', search: '?name=QA&token=fixture' + query }, addEventListener() {} }
  });
  vm.runInContext(source, context);
  const run = expression => vm.runInContext(expression, context);
  run('globalThis.messages = []; showToast = message => messages.push(message); renderAll = () => {};');
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
  await run("Promise.all(['read', 'memberInsights', 'columnList'].map(action => memberRecords({action, date: state.selectedDate})))");
  assert.equal(exchanges, 1);
  assert.equal(run('state.session'), 'renewed');
});

test('an older or denied date read cannot remain on the current screen', async () => {
  let releaseOldRead;
  const oldRead = new Promise(resolve => { releaseOldRead = resolve; });
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
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
  assert.equal(run('state.recordDate'), '');
  assert.equal(run('state.record.headerMessage'), '');
  assert.match(run('state.memberError'), /불러오지 못했어요/);
});

test('cold member date renders before optional calls and reuses published columns', async () => {
  const calls = [];
  const run = app(async (_,request)=>{
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

test('HTTP 200 denial preserves the draft and shows failure before any success', async () => {
  const run = app(async () => Response.json({ status: 'denied' }));
  run('state.recordDate = state.selectedDate; globalThis.applied = false;');
  assert.equal(await run("saveAction(() => savePatchLive({diet:{water:500}}), 'saved', () => { applied = true; })"), false);
  assert.equal(run('applied'), false);
  assert.equal(run('state.record.diet.water'), 0);
  assert.match(run('messages.at(-1)'), /저장을 확인하지 못했어요/);
});

test('coach replies keep the target member workout feedback and use the correct auth', async () => {
  const calls = [];
  const run = app(async (_, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    return body.action === 'read' ? Response.json({ feedback: { workout: 'target workout' } }) :
      Response.json({ status: 'success' });
  });
  run("state.appMode = 'coach'; state.trainerPassword = 'fixture-coach'; state.record.feedback.workout = 'different member';");
  await run("sendCoachDietFeedback('target', 'diet reply')");
  assert.deepEqual(calls.map(({ action, member, date: day, password, token }) => [action, member, day, password, token]),
    [['read', 'target', date, 'fixture-coach', undefined], ['patchData', 'target', date, 'fixture-coach', undefined]]);
  assert.equal(calls[1].patch.feedback.workout, 'target workout');
  assert.equal(calls[1].patch.feedback.diet, 'diet reply');
});

test('empty and legacy records render safely, preserving photo references and food fields', () => {
  const run = app(() => { throw Error('unexpected network request'); }, '&date=2026-13-01');
  assert.equal(run('state.selectedDate'), run('getTodayKST()'));
  for (const tab of ['report', 'lesson', 'diet', 'body', 'feedback']) {
    const result = run('state.memberTab=' + JSON.stringify(tab) + '; renderMemberView()');
    assert.doesNotMatch(result, /NaN|undefined|데드버그 \(개인숙제\)/);
  }
  run(`
    state.record = normalizeRecord({
      diet:{lunch:{desc:'<b>메뉴</b>',cal:'<b>칼로리</b>',foods:[{name:'밥'}],
        photoFeedback:'사진 의견',photos:[{fileId:'legacy-photo'},'https://untrusted.test/picture']}},
      routines:[{name:'운동',sets:'3',reps:'<b>횟수</b>',weight:'<b>무게</b>',completedSets:null}],
      memos:[{text:'<b>메모</b>'}]
    });
  `);
  const diet = run("state.memberTab='diet'; renderMemberView()");
  assert.match(diet, /data-fit-photo-id="legacy-photo"/);
  assert.match(diet, /&lt;b&gt;칼로리/);
  assert.doesNotMatch(diet, /untrusted\.test|\[object Object\]/);
  assert.equal(run('state.record.diet.lunch.foods[0].name'), '밥');
  assert.equal(run('state.record.diet.lunch.photoFeedback'), '사진 의견');
  assert.match(run("state.memberTab='lesson'; renderMemberView()"), /&lt;b&gt;무게/);
  assert.match(run("state.memberTab='feedback'; renderMemberView()"), /&lt;b&gt;메모/);
  assert.match(run("mealPhotoMarkup('data:image/jpeg;base64,AAAA','lunch','',0)"),/data-fit-photo-index="0"/);
  assert.doesNotMatch(run("mealPhotoMarkup('data:image/jpeg;base64,AAAA','lunch','',0)"),/base64/);
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
