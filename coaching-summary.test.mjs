import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync(new URL('./cloudflare-worker.js',import.meta.url),'utf8');
const mod=new vm.SourceTextModule(source+'\nexport {buildMemberInsights,buildOverview};',{
  context:vm.createContext({console,Date,Map,Set,URL,Response,Request,Headers,TextEncoder,TextDecoder,AbortSignal,performance,crypto,btoa,atob,Uint8Array,fetch:async()=>{throw Error('No external calls in tests');}})
});
await mod.link(()=>{});await mod.evaluate();
const {buildMemberInsights,buildOverview}=mod.namespace;
const routine={name:'스쿼트',sets:3,completedSets:[true,false,true],weight:40,reps:10};
const rows=[
  {date:'2026-11-15',data:{routines:[routine],diet:{breakfast:{desc:'식사'}},feedback:{workout:'좋아요'}}},
  {date:'2026-11-16',data:{routines:[routine,routine],diet:{breakfast:{photos:['photo']}},feedback:{workout:'확인',diet:'확인'}}},
  {date:'2026-11-16',data:{routines:[routine],diet:{lunch:{desc:'식사'}},feedback:{diet:'확인'}}},
  {date:'2026-11-17',data:{routines:[{...routine,completedSets:[]}],diet:{dinner:{foods:[{name:'밥'}]}},feedback:{workout:'  '}}},
  {date:'2026-11-18',data:{routines:[routine],diet:{breakfast:{desc:'   '}},feedback:{diet:'확인'}}},
  {date:'2026-11-19',data:{routines:[routine],diet:{breakfast:{desc:'미래'}},feedback:{workout:'미래'}}}
];
const report=buildMemberInsights(rows,'2026-11-18');
assert.deepEqual(Array.from(report.workoutDays),['2026-11-15','2026-11-16','2026-11-18']);
assert.deepEqual(JSON.parse(JSON.stringify(report.careSummary)),{start:'2026-11-16',end:'2026-11-18',workoutDays:2,dietDays:2,feedbackDays:2});
assert.equal(buildMemberInsights([],'2026-11-18').careSummary.feedbackDays,0);
assert.equal(buildMemberInsights([{date:'2026-11-01',data:{diet:{breakfast:{desc:'식사'}}}}],'2026-11-01').careSummary.start,'2026-10-26');

const overview=await buildOverview(async(path)=>{
  if(path.includes('fit_members?'))return [{id:'one',name:'회원A'},{id:'two',name:'회원B'}];
  if(path.includes('fit_coach_feedback?'))return [];
  if(path.includes('fit_direct_videos?'))return [{member_id:'one',feedback:''},{member_id:'one',feedback:'답변'},{member_id:'two',feedback:'  '},{member_id:'unknown',feedback:''}];
  return [{member_id:'one',record_date:'2026-11-18',routines:[routine],diet:{breakfast:{desc:'식사'}},feedback:{diet:'답변'}}];
},'2026-11-18');
assert.equal(overview.members[0].pendingWorkout,true);
assert.equal(overview.members[0].pendingDiet,false);
assert.equal(overview.members[0].directPendingVideos,1);
assert.equal(overview.members[1].directPendingVideos,1);
assert.equal(overview.members[1].activeToday,false);

const denied=await mod.namespace.default.fetch(new Request('https://example.test/api/records',{method:'POST',body:JSON.stringify({action:'memberInsights',member:'회원A',date:'2026-11-18'})}),{});
assert.equal(denied.status,403);
const wrongSession=await mod.namespace.default.fetch(new Request('https://example.test/api/records',{method:'POST',body:JSON.stringify({action:'memberInsights',member:'회원A',date:'2026-11-18',session:'invalid'})}),{MEMBER_SESSION_SECRET:'x'.repeat(40)});
assert.equal(wrongSession.status,403);
const html=fs.readFileSync(new URL('./cloudflare-assets/index.html',import.meta.url),'utf8');
let scripts=0;for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)){if(match[1].trim()){new vm.Script(match[1]);scripts++;}}
console.log('PASS: weekly boundaries, unique record days, empty state, pending record/video separation, unauthorized access, '+scripts+' app scripts parse');
