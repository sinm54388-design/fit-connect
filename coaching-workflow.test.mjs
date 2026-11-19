import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source=readFileSync(new URL('./cloudflare-assets/fit-coaching.js',import.meta.url),'utf8');
const html=readFileSync(new URL('./cloudflare-assets/index.html',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));

function harness(storage=new Map()) {
  const context={mode:'member',member:'fixture',token:'fixture-access',date:'2026-11-19'};
  const nodes=new Map();
  const element=(tagName='DIV')=>({
    tagName:tagName.toUpperCase(),children:[],dataset:{},hidden:false,value:'',defaultValue:'',
    append(...children){this.children.push(...children);},
    replaceChildren(...children){this.children=children;},
    querySelector(){return null;}
  });
  const requests=[];
  const window={};
  const globals=createContext({
    window, Date, Intl,
    document:{addEventListener(){},createElement:element,getElementById:name=>nodes.get(name)},
    context,
    currentMode:'member',activeMemberName:context.member,memberToken:context.token,selectedDate:context.date,
    getSaveContext:()=>({...context}),hasMemberAccess:()=>true,videoListOwner:()=>context.member,
    formVideoListOwner:context.member,formVideos:[],
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    navigator:{onLine:false},setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},
    setSaveStatus(){},loadDataFromCloud(){},
    apiPost:async request=>{requests.push(plain(request));return {status:'success'};},
    updateAndSave:async()=>true
  });
  // Inspect the same internal helpers used by the rendered cards, without production data.
  const instrumented=source.replace('  document.addEventListener(\'DOMContentLoaded\',setup);',
    '  window.inspect={postureTasks,weeklyLines,putWorkoutChange};');
  runInContext(instrumented,globals);
  return {feature:window.fitCoaching,inspect:window.inspect,globals,context,requests,nodes,element,storage};
}

test('coach timestamp carries through a same-exercise retake and completion closes the task',()=>{
  const {feature,inspect}=harness();
  const before={id:'first',name:'데드 리프트',createdAt:'2026-11-17',feedback:'0:12 · 바를 몸 가까이'};
  const after={id:'second',name:'데드리프트',createdAt:'2026-11-18',question:'__FIT_RETAKE__:first\n이렇게 맞나요?'};
  assert.equal(feature.feedbackParts(before.feedback).seconds,12);
  assert.equal(feature.videoQuestion(after),'이렇게 맞나요?');
  assert.equal(inspect.postureTasks([after,before])[0].id,'first');
  after.feedback='0:05 · 잘 잡혔어요.\n✓ 자세 과제 완료 · 2026-11-19';
  assert.equal(inspect.postureTasks([before,after]).length,0);
  assert.equal(feature.feedbackParts(after.feedback).completedAt,'2026-11-19');
  assert.equal(feature.feedbackParts('기존 피드백').text,'기존 피드백');
});

test('offline set selection survives reload, latest selection wins and replays original date',async()=>{
  const first=harness();
  first.feature.recordSet({id:'routine'},0,false);
  first.inspect.putWorkoutChange(first.context,{id:'routine',index:0,checked:true},0);
  await first.feature.flushWorkoutQueue();
  assert.equal(first.requests.length,0);
  const reopened=harness(first.storage);
  const routines=[{id:'routine',sets:2,completedSets:[false,false]}];
  reopened.feature.applyWorkoutChanges(routines);
  assert.deepEqual(routines[0].completedSets,[true,false]);
  reopened.context.date='2026-11-20';
  reopened.globals.navigator.onLine=true;
  await reopened.feature.flushWorkoutQueue();
  assert.equal(reopened.requests[0].date,'2026-11-19');
  assert.deepEqual(reopened.requests[0].changes,[{id:'routine',index:0,checked:true}]);
  assert.equal(first.storage.size,0);
});

test('failed coach or workout reads are not reported as completed work',async()=>{
  const {inspect,feature,context,globals,storage}=harness();
  inspect.putWorkoutChange(context,{id:'routine',index:2,checked:true},2);
  globals.navigator.onLine=true;
  globals.apiPost=async()=>({status:'error'});
  await feature.flushWorkoutQueue();
  assert.equal(storage.size,1);
  const lines=plain(inspect.weeklyLines(null,[],'2026-11-16','2026-11-19',true));
  assert.equal(lines[0],'운동 기록 확인 불가');
  assert.match(lines.at(-1),/일부 영상 조회 실패/);
});

test('weekly card reports period-specific changes and the coach completion date',()=>{
  const {inspect}=harness();
  const insights={careSummary:{workoutDays:3},progress:[{name:'스쿼트',points:[
    {date:'2026-11-15',weight:35},{date:'2026-11-16',weight:40},{date:'2026-11-19',weight:45},
    {date:'2026-11-20',weight:50}
  ]}]};
  const videos=[{createdAt:'2026-11-12',feedback:'완료\n✓ 자세 과제 완료 · 2026-11-19'}];
  assert.deepEqual(plain(inspect.weeklyLines(insights,videos,'2026-11-16','2026-11-19',false)),
    ['운동 3일','스쿼트 40 → 45kg','자세 과제 완료 1개']);
});

test('the normal production member and coach paths load the new hooks',()=>{
  assert.match(html,/defer src="\/fit-coaching\.js\?v=/);
  assert.match(html,/fitCoaching\?\.refreshVideoTasks\(\)/);
  assert.match(html,/fitCoaching\?\.renderHomework\(appData\)/);
  assert.match(html,/fitCoaching\?\.recordSet\(ex,setIdx,checked\)/);
  for (const [,code] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    assert.doesNotThrow(()=>new Function(code));
  }
});
