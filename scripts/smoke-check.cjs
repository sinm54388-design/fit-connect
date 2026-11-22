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
  assert(html.includes("const appsSaved = await saveFullRecordLive"), name + ': Apps Script save ordering removed');
  assert(html.includes("action: 'dietSave'"), name + ': photo persistence route removed');
  assert(html.includes("action: 'dietPhotoDelete'"), name + ': photo deletion request missing');
  assert(html.includes("cd-meal-photo-delete"), name + ': coach photo delete control missing');
  assert(html.includes("meal-delete-photo"), name + ': member photo delete control missing');
  assert(html.includes("recObj?.deletedPhotoMeals || []"), name + ': photo tombstones not respected');
  assert(html.includes("action: 'coachFeedbackSave'"), name + ': durable coach feedback save missing');
  assert(html.includes('recObj?.coachFeedbackStored'), name + ': durable coach feedback hydration missing');
  assert(html.includes('mergeDietRecords(asObj?.diet, recObj?.diet)'), name + ': photo merge missing');
}
new vm.SourceTextModule(worker, { identifier: 'cloudflare-worker.js' });
assert(worker.includes("fit_meal_photos"), 'independent photo storage route missing');
assert(worker.includes("action==='dietPhotoDelete'"), 'authenticated photo deletion route missing');
assert(worker.includes("deletedPhotoMeals"), 'deleted photo marker missing');
assert(worker.includes("fit_coach_feedback"), 'independent coach feedback storage missing');
assert(worker.includes("action==='dietSave'"), 'diet API action missing');
assert(worker.includes("appsScriptAcceptsMember"), 'member token verification missing');
console.log('FIT-CONNECT offline regression smoke checks passed.');
