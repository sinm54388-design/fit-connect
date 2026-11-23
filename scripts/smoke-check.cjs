// Offline smoke checks. No API keys, member records, or network calls.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const index = fs.readFileSync('cloudflare-assets/index.html','utf8');
const v2 = fs.readFileSync('cloudflare-assets/v2.html','utf8');
const worker = fs.readFileSync('cloudflare-worker.js','utf8');
assert.equal(index, v2, 'index.html and v2.html must stay synchronized');
for (const [name, html] of [['index.html', index], ['v2.html', v2]]) {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert(scripts.length, name + ': missing inline app script');
  for (const [, code] of scripts) if (code.trim()) new vm.Script(code, { filename: name });
  assert(html.includes('href="/v2.tailwind.css?') && !html.includes("cdn.tailwindcss.com"), name + ": static stylesheet missing");
  assert(!html.includes("saveFullRecordLive"), name + ": full-day record write fallback is unsafe");
  assert(html.includes("action: 'dietSave'"), name + ': photo persistence route removed');
  assert(html.includes("action: 'dietPhotoDelete'"), name + ': photo deletion request missing');
  assert(html.includes("cd-meal-photo-delete"), name + ': coach photo delete control missing');
  assert(html.includes("meal-delete-photo"), name + ': member photo delete control missing');
  assert(html.includes("recObj?.deletedPhotoMeals || []"), name + ': photo tombstones not respected');
  assert(html.includes("action: 'coachFeedbackSave'"), name + ': durable coach feedback save missing');
  assert(html.includes('weeklyCheckinDays'), name + ': weekly check-in summary missing');
  assert(html.includes('meal-copy-yesterday'), name + ': yesterday meal quick entry missing');
  assert(html.includes('meal-yesterday-btn'), name + ': direct yesterday meal button missing on diet cards');
  assert(html.includes("document.getElementById('meal-copy-yesterday')?.click()"), name + ': diet card shortcut must open prefilling modal');
  assert(html.includes("PT 세트 기록"), name + ': PT routines must expose per-set controls');
  assert(html.includes('routine-set-toggle'), name + ': per-set workout tracking missing');
  assert(html.includes('function enqueueWorkoutSave(') && html.includes('function flushWorkoutSave(job)'), name + ': queued workout saves missing');
  assert(html.includes("action: 'setProgressBatch'") && html.includes("data: { routines: draft.routines }"), name + ": workout saves must use scoped writes");
  assert(!html.includes("postAppsScript({...auth,data:snapshot})"), name + ': full-day workout save fallback could overwrite meal data');
  assert(html.includes('workout-save-retry'), name + ': failed-save retry button missing');
  assert(html.includes('document.visibilityState'), name + ': background flush missing');
  assert(html.includes('상세 통계 · 운동 달성률'), name + ': home details collapse missing');
  assert(html.includes('<!-- High-Visibility FIT-CONNECT MAGAZINE -->'), name + ': visible magazine missing');
  assert(html.includes('cd-quick-tip'), name + ': coach quick reply chips missing');
  assert(html.includes('최근 7일 한눈에 보기'), name + ': coach instant overview missing');
  assert(html.includes('home-quick-workout') && html.includes('home-quick-diet'), name + ': member home shortcuts missing');
  assert(html.includes('video-upload-status'), name + ': persistent video progress missing');
  assert(html.indexOf('<!-- High-Visibility FIT-CONNECT MAGAZINE -->') < html.indexOf('<!-- Important shortcuts above educational content -->'), name + ': magazine should precede today task shortcuts');
  assert(html.includes('id="meal-items-list"'), name + ': item-level meal editor missing');
  assert(html.includes('redrawItems()') && html.includes('recomputeItems()'), name + ': item totals/editor refresh missing');
  assert(html.includes("foods:foodEntries.map"), name + ': structured meal foods not saved');
  assert(html.includes("const savedItems=Array.isArray(m.foods)"), name + ': legacy meal migration not guarded');
  assert(html.includes("const recentKey='fit_food_recent_session_v1'"), name + ': recent foods not tab scoped');
  assert(html.includes("if (state.coachFilter === 'diet')") && html.includes("state.coachFilter === 'workout'"), name + ': category feedback filters missing');
  assert(html.includes('data-cfilter="diet"') && html.includes('data-cfilter="workout"'), name + ': diet/workout coach links missing');
  assert(html.includes("['videos', '영상 대기', videoWaiting]"), name + ': video feedback inbox missing');
  assert(html.includes("action: 'memberArchive'"), name + ': member archive UI missing');
  assert(html.includes('recObj?.coachFeedbackStored'), name + ': durable coach feedback hydration missing');
  assert(html.includes('mergeDietRecords(asObj?.diet, recObj?.diet, recObj?.deletedPhotoMeals || [])'), name + ': photo merge missing');
}
// Exercise the actual merge implementation, not just source string presence.
const mergeSource = index.match(/    function mergeDietRecords\([\s\S]*?\n    }\n\n    function unwrapDailyRecord/);
assert(mergeSource, 'mergeDietRecords source not found');
const mergeContext = vm.createContext({
  extractPhotoSrc: meal => (Array.isArray(meal?.photos) ? meal.photos[0] : '') || meal?.photo || ''
});
vm.runInContext(mergeSource[0].replace(/\n    function unwrapDailyRecord$/, ''), mergeContext);
const oldDiet = { lunch: { desc: 'old mirror', cal: '100', foods: [], photos: [] } };
const newDiet = { lunch: { desc: 'egg 2개', cal: '155', foods: [{ name: '삶은 계란', grams: 100, kcal: 155 }], photos: ['direct:photo'] } };
const merged = mergeContext.mergeDietRecords(oldDiet, newDiet);
assert.equal(merged.lunch.desc, 'egg 2개', 'stale mirror replaced saved meal text');
assert.equal(merged.lunch.foods.length, 1, 'structured meal items disappeared');
assert.equal(merged.lunch.photos[0], 'direct:photo', 'meal photo disappeared');
const cleared = mergeContext.mergeDietRecords(oldDiet, { lunch: { desc: '', cal: '', foods: [], photos: [] } });
assert.equal(cleared.lunch.foods.length, 0, 'deleted foods were resurrected');
assert.equal(cleared.lunch.desc, '', 'deleted meal text was resurrected');

new vm.SourceTextModule(worker, { identifier: 'cloudflare-worker.js' });
assert(worker.includes("fit_meal_photos"), 'independent photo storage route missing');
assert(worker.includes("action==='dietPhotoDelete'"), 'authenticated photo deletion route missing');
assert(worker.includes("deletedPhotoMeals"), 'deleted photo marker missing');
assert(worker.includes("fit_coach_feedback"), 'independent coach feedback storage missing');
assert(worker.includes("action==='dietSave'"), 'diet API action missing');
assert(worker.includes("appsScriptAcceptsMember"), 'member token verification missing');
assert(worker.includes("code:'member_archived'"), 'archived member access block missing');
assert(worker.includes("handleAppsScriptPost(request,env)"), 'archived member legacy API bridge guard missing');
assert(worker.includes("weeklyCheckinDays:_c.size"), '7-day check-in aggregation missing');
assert(worker.includes("fit_coach_feedback?select=member_id"), 'coach overview lacks durable feedback read');
console.log('FIT-CONNECT offline regression smoke checks passed.');

const result = require('node:child_process').spawnSync(process.execPath, [
  '--experimental-vm-modules', '--test', 'coaching-summary.test.mjs', 'coaching-workflow.test.mjs', 'v2-release-safety.test.mjs'
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
