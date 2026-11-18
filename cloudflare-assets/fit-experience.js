(() => {
  const id = name => document.getElementById(name);
  const make = (tag, text, className) => Object.assign(document.createElement(tag), {textContent:text,className:className||''});
  const button = (text, action, style='') => Object.assign(make('button',text,'fit-action '+style),{type:'button',onclick:action});
  const contextReady = () => currentMode==='member' && workflowReadyKey===workflowContextKey();
  const foodKeys = ['breakfast','lunch','dinner','snack'];
  const weightPrefix = '__FIT_MEMBER_WEIGHT__:';
  const weekMs = 604800000;
  const timestamp = date => Date.parse(date+'T12:00:00Z');
  const iso = time => new Date(time).toISOString().slice(0,10);
  const sunday = date => timestamp(date)-new Date(timestamp(date)).getUTCDay()*86400000;
  const recorded = data => (data?.routines||[]).some(r=>r.completedSets?.some(Boolean));
  const readWeight = data => Number((data?.memos||[]).find(m=>String(m.text||'').startsWith(weightPrefix))?.text.slice(weightPrefix.length))||0;
  let insight;
  let insightKey='';
  let compareBody=false;
  let coachItems=[];
  let coachDate='';
  let initialStreakKey='';
  let lastStreak=0;
  let coachNav;

  function sheet(title) {
    const old=id('fitSharedSheet');
    if(old?.open)old.close();
    old?.remove();
    const dialog=make('dialog','','fit-shared-sheet');
    dialog.id='fitSharedSheet';
    dialog.setAttribute('aria-labelledby','fitSharedTitle');
    const panel=make('div','','report-sheet-panel');
    panel.append(make('div','','report-sheet-handle'));
    const header=make('header','');
    const heading=make('h2',title);
    heading.id='fitSharedTitle';
    const close=button('×',()=>dialog.close());
    close.setAttribute('aria-label','닫기');
    header.append(heading,close);
    const content=make('div','','fit-sheet-content');
    panel.append(header,content);
    dialog.append(panel);
    document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
    dialog.showModal();
    return {dialog,content};
  }

  function memberData(data) {
    if (!id('fitMacros') || !contextReady() || !data) return;
    const nutrients=['carb','prot','fat'].map((key,i)=>foodKeys.reduce((sum,meal)=>sum+Math.max(0,Number(data.diet?.[meal]?.[key])||0),0)*(i===2?9:4));
    id('fitMacros').replaceChildren(...nutrients.map((value,index)=>{
      const bar=make('i','');bar.dataset.macro=index;bar.style.flex=String(value);return bar;
    }));
    id('fitMacros').setAttribute('aria-label',nutrients.some(Boolean)?'열량 기준 탄수화물·단백질·지방 비율':'탄단지 기록 없음');
    const water=Math.max(0,Number(data.diet?.water)||0)/1000;
    const sameDay=insightKey===workflowContextKey();
    const weight=readWeight(data)||(sameDay?Number(insight?.inbody?.at(-1)?.weight):0);
    id('fitWaterWeight').textContent='물 '+water.toLocaleString()+' L · 체중 '+(weight>0?weight.toLocaleString()+' kg':'—');
    const dietReply=id('fitDietReply');
    const feedback=String(data.feedback?.diet||'').trim();
    dietReply.hidden=!feedback;
    dietReply.querySelector('p').textContent=feedback;
    const mood=readDailyCheckin(data).mood;
    const burden={good:'1',normal:'2',tired:'3'}[mood];
    id('fitBurden').textContent=burden?'자가 체크 부담 '+burden+'/3':'상태 체크를 남기면 자가 체크 부담을 볼 수 있어요.';
    if(initialStreakKey!==workflowContextKey()){
      initialStreakKey=workflowContextKey();
      lastStreak=0;
      id('fitStreak').hidden=true;
      id('fitPr').hidden=true;
      loadStreak(getSaveContext());
    }
    if(lastStreak>0)id('fitStreak').hidden=false;
  }

  async function loadStreak(context) {
    const start=sunday(context.date);
    if(!Number.isFinite(start))return;
    const months=[...new Set([iso(start-2*weekMs).slice(0,7),context.date.slice(0,7)])];
    try {
      const results=await Promise.all(months.map(month=>cachedExtraRead({action:'workoutHistory',member:context.member,date:context.date,token:context.token,month})));
      if(!isCurrentSaveContext(context)||results.some(r=>r.status!=='success'))return;
      const days=results.flatMap(r=>r.days||[]);
      if(recorded(appData))days.push(context.date);
      const weeks=new Set(days.filter(day=>day<=context.date).map(sunday));
      let run=0;
      while(run<3&&weeks.has(start-run*weekMs))run++;
      lastStreak=run;
      id('fitStreak').textContent=run+(run===3?'주+':'주')+' 연속';
      id('fitStreak').hidden=!run;
    } catch {}
  }

  function memberInsights(data,date) {
    if(!id('fitPr'))return;
    insight=data;
    insightKey=workflowContextKey();
    const pr=(data.progress||[]).find(exercise=>{
      const points=exercise.points||[], today=points.find(p=>p.date===date);
      const previous=points.filter(p=>p.date<date);
      return today && previous.length && Number(today.weight)>Math.max(...previous.map(p=>Number(p.weight)));
    });
    id('fitPr').textContent=pr?pr.name+' 기록 최고 중량':'';
    id('fitPr').hidden=!pr;
    renderBodyCompare();
    memberData(appData);
  }

  function renderBodyCompare() {
    const root=id('fitBodyCompare');
    if(!root)return;
    const rows=insightKey===workflowContextKey()?insight?.inbody||[]:[];
    const first=rows[0],last=rows.at(-1);
    root.textContent=last ? [['체중','weight','kg'],['골격근량','muscle','kg'],['체지방률','fat','%']].map(([label,key,unit])=>{
      const current=Number(last[key]), start=Number(first[key]);
      return label+' '+(compareBody && rows.length>1?start.toFixed(1)+' → ':'')+current.toFixed(1)+unit;
    }).join(' · ') : '코치가 등록한 체형 측정 기록이 아직 없어요.';
    id('fitCompareToggle').setAttribute('aria-pressed',String(compareBody));
  }

  function showWeight() {
    if(!contextReady())return;
    const context=getSaveContext();
    const {dialog,content}=sheet('체중 기록 · '+context.date);
    const field=make('input','');
    Object.assign(field,{type:'number',min:'20',max:'400',step:'0.1',inputMode:'decimal',required:true,value:readWeight(appData)||''});
    field.setAttribute('aria-label','체중 kg');
    const status=make('p','');
    const save=button('체중 저장',async ()=>{
      if(!isCurrentSaveContext(context)||!field.reportValidity())return;
      save.disabled=true;
      const value=Number(field.value);
      const ok=await updateAndSave(data=>{
        data.memos=(data.memos||[]).filter(m=>!String(m.text||'').startsWith(weightPrefix));
        data.memos.push({id:'member-weight-'+context.date,from:'member',text:weightPrefix+value,time:nowTimeStr()});
      });
      if(ok){dialog.close();showToast('체중을 기록했어요.');}
      else {status.textContent='저장 실패 · 연결을 확인해 주세요.';save.disabled=false;}
    },'primary');
    content.append(field,save,status);
  }

  function addMealTags() {
    const host=id('fitMealSheet')?.querySelector('[data-sheet-body]');
    if(!host)return;
    for(const [key,name] of Object.entries({breakfast:'아침',lunch:'점심',dinner:'저녁',snack:'간식'})){
      const section=id('meal-section-'+key);
      if(!section)continue;
      const tags=make('div','','fit-meal-tags');
      tags.setAttribute('aria-label',name+' 빠른 기록');
      for(const text of ['클린식','일반식','외식','단백질/간식']){
        tags.append(button(text,async ()=>{
          if(!contextReady()||!host.contains(section))return;
          window.fitMemberReport.mealStatus(key,'식단을 저장하고 있어요…');
          tags.querySelectorAll('button').forEach(b=>b.disabled=true);
          const ok=await updateAndSave(data=>{
            const meal=data.diet[key]||{};
            const foods=workflowMealFoods(meal).filter(food=>String(food.name||'').trim());
            if(!foods.some(food=>food.name===text))foods.push({name:text,cal:'',carb:'',prot:'',fat:''});
            data.diet[key]={...meal,foods,desc:foods.map(food=>food.name).join('\n')};
          });
          tags.querySelectorAll('button').forEach(b=>b.disabled=false);
          window.fitMemberReport.mealStatus(key,ok?'빠른 식단 기록을 저장했어요.':'저장하지 못했어요. 다시 시도해 주세요.');
        }));
      }
      section.prepend(tags);
    }
  }

  function missionTip() {
    const routine=(appData?.routines||[]).find(r=>String(r.id)===id('reportMission')?.dataset.id);
    if(!contextReady()||!routine)return;
    const {content}=sheet('10초 자세 팁 · '+routine.name);
    const note=String(routine.note||'').replace(/^\s*\[미션\]\s*/,'').trim();
    if(note)content.append(make('p','코치 큐잉 · '+note,'fit-callout'));
    const guides=[
      ['준비','코치가 안내한 시작 자세와 중량을 확인해요.'],
      ['동작','먼저 천천히 움직이며 몸통이 안정되는지 확인해요.'],
      ['마무리','불편함이 생기면 멈추고 코치에게 알려주세요.']
    ];
    const figure=make('div','','fit-tip-figure');
    figure.innerHTML='<svg viewBox="0 0 300 90" aria-hidden="true"><g fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round"><circle cx="48" cy="19" r="8"/><path d="M48 29v25m-15-13 15-6 15 6M48 54l-10 23m10-23 10 23"/><circle cx="151" cy="24" r="8"/><path d="M148 34l-8 20m0 0-18 9 11 16m7-25 22 11 13 14m-24-41 23 7"/><circle cx="251" cy="19" r="8"/><path d="M251 29v25m-17-17 17 0 17 0M251 54l-8 23m8-23 8 23"/></g></svg>';
    const list=make('ol','');
    guides.forEach(([label,detail])=>list.append(make('li',label+' · '+detail)));
    content.append(figure,list,button('코치에게 자세 질문',()=>{id('fitSharedSheet')?.close();openCoachQuestion();}));
  }

  async function magazine() {
    if(!contextReady())return;
    const {dialog,content}=sheet('운동이 더 쉬워지는 코치 인사이트');
    const categories=['자세 교정','식단 상식','코어 호흡'];
    const tag=article=>/영양|식단|음식/.test((article.category||'')+' '+article.title)?1:/코어|호흡/.test(article.title+' '+article.summary)?2:0;
    const tabs=make('div','','fit-filter-row'), articles=make('div','글을 불러오는 중…');
    content.append(tabs,articles);
    try {
      const response=await fetch('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
        body:JSON.stringify({...apiCredentials(),action:'columnList'})});
      const result=await response.json();
      if(!dialog.open)return;
      if(result.status!=='success')throw Error('columnList');
      const show=selected=>{
        articles.replaceChildren();
        [...tabs.children].forEach((b,index)=>b.setAttribute('aria-pressed',String(index===selected)));
        for(const article of (result.columns||[]).filter(item=>tag(item)===selected)){
          const entry=make('details','','fit-magazine-entry');
          const summary=make('summary',article.title);
          entry.append(summary,make('p',article.summary||''));
          (Array.isArray(article.content)?article.content:String(article.content||'').split(/\n+/)).filter(Boolean).forEach(line=>entry.append(make('p',line)));
          const key='fitInsightLike:'+String(article.id);
          let liked=false;try{liked=localStorage.getItem(key)==='1';}catch{}
          const reaction=button('유용해요 👍',()=>{
            liked=!liked;
            reaction.setAttribute('aria-pressed',String(liked));
            try{localStorage.setItem(key,liked?'1':'0');}catch{}
          });
          reaction.setAttribute('aria-pressed',String(liked));
          entry.append(reaction);
          articles.append(entry);
        }
        if(!articles.children.length)articles.append(make('p','이 주제에 발행된 코치 노트가 아직 없어요.'));
      };
      categories.forEach((name,index)=>tabs.append(button('#'+name,()=>show(index))));
      show(0);
    }catch{if(dialog.open)articles.textContent='코치 노트를 불러오지 못했어요. 잠시 후 다시 열어주세요.';}
  }

  function setupMember() {
    const home=id('memberHomePage');
    if(!home||!id('reportActivityRings'))return;
    const header=make('div','','fit-member-tools');
    const streak=make('span','','fit-pill'); streak.id='fitStreak';streak.hidden=true;
    header.append(streak,button('코치 질문',openCoachQuestion));
    id('appHeader').append(header);
    const pr=make('span','','fit-pill');pr.id='fitPr';pr.hidden=true;
    id('fcGreet').before(pr);
    const summaries=id('reportSummaries');
    const mini=make('span','','fit-mini-ring');
    summaries.children[0].append(mini);
    new MutationObserver(()=>mini.style.setProperty('--fit-mini',id('reportWorkoutBar').style.width||'0%')).observe(id('reportWorkoutBar'),{attributes:true,attributeFilter:['style']});
    const macros=make('span','','fit-macros');macros.id='fitMacros';
    const body=make('small','물 — · 체중 —');body.id='fitWaterWeight';
    summaries.children[1].append(macros,body);
    const coach=id('fcCoachCard'), coachLink=button('수업일지 ›',()=>navigateMemberPage('workout'),'fit-brief-link');
    coach.after(coachLink);
    const tip=button('자세 팁 ▶',missionTip);
    tip.id='reportMissionTip';
    const mission=id('reportMission'), actions=make('div','','fit-mission-actions');
    mission.before(actions);actions.append(mission,tip);
    const dietReply=make('section','','fit-soft-card');dietReply.id='fitDietReply';dietReply.hidden=true;
    dietReply.append(make('strong','코치 식단 답장'),make('p',''));
    id('memberDietSection').querySelector('.member-page-heading').after(dietReply);
    const growth=make('section','','fit-soft-card');
    const compare=make('p','');compare.id='fitBodyCompare';
    const toggle=button('처음 vs 지금',()=>{
      compareBody=!compareBody;
      toggle.textContent=compareBody?'현재 보기':'처음 vs 지금';
      renderBodyCompare();
    });toggle.id='fitCompareToggle';
    const burden=make('p','');burden.id='fitBurden';
    growth.append(make('strong','체형 기록'),toggle,compare,burden);
    id('memberGrowthPage').querySelector('.member-page-heading').after(growth);
    renderBodyCompare();
    const fab=button('+',()=>{
      if(!contextReady())return;
      const {dialog,content}=sheet('빠른 기록');
      content.append(button('식단 빠른 기록',()=>{dialog.close();window.fitMemberReport.quickMeal();}),
        button('물 500ml 추가',()=>{
          if(!contextReady())return;
          dialog.close();
          adjustWater(500);
        }),button('체중 기록',()=>{dialog.close();showWeight();}));
    },'fit-fab');
    fab.setAttribute('aria-label','빠른 기록');document.body.append(fab);
    addMealTags();
    document.addEventListener('click',event=>{
      if(currentMode==='member'&&event.target.closest('#fcMagazineShortcut')){
        event.stopImmediatePropagation();
        magazine();
      }
    },true);
    memberData(appData);
  }

  const coachPages=[['today','오늘수업','fa-clipboard-list'],['members','회원관리','fa-user-group'],['diet','식단','fa-utensils'],['care','잠수·재등록','fa-calendar-check']];
  const coachAliases={overview:'today',members:'members',routine:'today',feedback:'today',growth:'members'};
  let coachPage='today';
  let rosterFilter='all';
  let renewalScan;
  const coachActive=()=>currentMode==='trainer'&&Boolean(trainerPassword);
  const dietQueue=()=>coachItems.filter(member=>member.pendingDiet);
  function careDays(member) {
    const last=timestamp(member.lastDate);
    return Number.isFinite(last)?Math.floor((timestamp(coachDate)-last)/86400000):null;
  }
  const needsCare=member=>{const days=careDays(member);return days===null||days>=4;};
  const coachContext=(member,date)=>({mode:'trainer',member,date,password:trainerPassword,token:memberToken});
  const withMember=(member,date)=>fetchLatest(coachContext(member,date),true);

  function coachTab(page) {
    if(!coachNav||!coachAliases[page])return;
    coachPage=coachAliases[page];
    id('fitCoachWork').hidden=false;
    renderCoachNav();
  }
  function renderCoachNav() {
    if(!coachNav)return;
    for(const item of coachNav.children){
      const active=item.dataset.coachTab===coachPage;
      item.classList.toggle('selected',active);
      if(active)item.setAttribute('aria-current','page');else item.removeAttribute('aria-current');
      const key=item.dataset.coachTab;
      item.querySelector('span').textContent=coachPages.find(row=>row[0]===key)[1]+(key==='diet'&&dietQueue().length?' '+dietQueue().length:'');
    }
    for(const key of ['today','diet','care']){
      const panel=id('fitCoach-'+key);
      if(panel)panel.hidden=coachPage!==key || (key==='today'&&trainerPage!=='overview');
    }
  }
  function goCoach(key) {
    if(key==='members')navigateTrainerPage('members');
    else navigateTrainerPage('overview');
    coachPage=key;
    renderCoachNav();
    if(key==='diet'||key==='care')document.querySelector('[data-trainer-page="overview"]').hidden=true;
    window.scrollTo({top:0,behavior:'instant'});
  }
  async function activateCoach(member,date) {
    if(!coachActive()||!member?.name||!date)return false;
    if(activeMemberName===member.name&&selectedDate===date&&workflowReadyKey===workflowContextKey())return true;
    stashWorkflowDraft();resetSaveStatus();clearRoutineCopyPreview();
    activeMemberName=member.name;selectedDate=date;
    id('currentDateInput').value=date;
    id('todayDateDisplay').textContent=date;
    id('trainerMemberSelect').value=member.name;
    resetRoutineForms();
    await loadDataFromCloud();
    return coachActive()&&activeMemberName===member.name&&selectedDate===date&&workflowReadyKey===workflowContextKey()&&Boolean(appData);
  }
  async function openExistingCoachPage(member,page) {
    if(await activateCoach(member,selectedDate)){
      navigateTrainerPage(page);
      if(page==='growth')loadMemberInsights(true);
    }
  }
  async function previousRecord(member,date) {
    const latestHint=member.lastDate&&member.lastDate<date?member.lastDate:'';
    const month=date.slice(0,7);
    const credentials={action:'workoutHistory',member:member.name,date,month,password:trainerPassword};
    let previousDate=latestHint;
    try{
      const history=await cachedExtraRead(credentials);
      const dates=[...(history.days||[]),...Object.values(history.previous||{}).map(x=>x.date)];
      previousDate=dates.filter(d=>d&&d<date).sort().at(-1)||latestHint;
    }catch{}
    if(!previousDate)return null;
    return {date:previousDate,data:await withMember(member.name,previousDate)};
  }
  async function briefing(member) {
    const date=coachDate||selectedDate;
    const {dialog,content}=sheet(member.name+' · 5분 전 브리핑');
    content.append(make('p','직전 기록을 불러오는 중…'));
    try{
      const [previous,current]=await Promise.all([previousRecord(member,date),withMember(member.name,date)]);
      if(!dialog.open)return;
      content.replaceChildren();
      const pain=String(previous?.data?.reflection?.bad||'').trim();
      content.append(make('p','지난 회차 특이사항 · '+(pain||'남긴 내용 없음'),'fit-callout'));
      const goals=(current?.routines||[]).map(r=>r.name+' '+(r.weight?r.weight+'kg':'맨몸')).join(' · ');
      const priorMission=(previous?.data?.routines||[]).find(r=>/미션|숙제/.test(r.note||''));
      content.append(make('p','오늘 목표 중량 · '+(goals||'아직 등록 전')),
        make('p','지난 미션 · '+(priorMission?(priorMission.completedSets||[]).filter(Boolean).length+'/'+priorMission.sets+'세트':'등록 기록 없음')));
    }catch{content.replaceChildren(make('p','직전 기록을 불러오지 못했어요.'));}
    if(dialog.open)content.append(button('30초 일지 작성',()=>{dialog.close();publisher(member);},'primary'));
  }
  const publishPresets=['오늘 동작이 안정적이었어요. 같은 템포를 이어가요.','중량보다 동작 범위와 호흡을 먼저 챙겨요.','다음 수업 때 불편했던 구간을 함께 확인할게요.'];
  async function publisher(member) {
    const date=coachDate||selectedDate;
    const {dialog,content}=sheet(member.name+' · 30초 일지 작성');
    content.append(make('p','루틴을 불러오는 중…'));
    try {
      const [previous,current]=await Promise.all([previousRecord(member,date).catch(()=>null),withMember(member.name,date)]);
      if(!dialog.open)return;
      const existing=current?.routines||[];
      const prior=previous?.data?.routines||[];
      const usingCurrent=existing.length>0;
      const rows=(usingCurrent?existing:prior).filter(r=>r.name&&Number(r.sets)>0).map(r=>({...r}));
      content.replaceChildren(make('p',usingCurrent?'선택 날짜에 등록된 루틴을 편집해요.':previous?previous.date+' 루틴 불러오기 · 완료 세트는 초기화돼요.':'복사할 루틴이 없어요. 기존 루틴 편집기에서 운동을 추가할 수 있어요.'));
      const list=make('div','','fit-publish-list');
      rows.forEach(item=>{
        const line=make('div','','fit-publish-row');
        const value=make('strong','');
        const draw=()=>value.textContent=item.weight?item.weight+'kg':'맨몸';
        const change=delta=>{item.weight=String(Math.max(0,Math.round(((Number(item.weight)||0)+delta)*10)/10));draw();};
        draw();
        line.append(make('span',item.name),button('−2kg',()=>change(-2)),value,button('+2kg',()=>change(2)));
        list.append(line);
      });
      content.append(list);
      const note=make('textarea','');
      note.value=current.feedback?.workout||'';
      note.maxLength=500;
      note.setAttribute('aria-label','코치 한 줄 피드백');note.placeholder='코치 한 줄 피드백';
      const presets=make('div','','fit-filter-row');
      publishPresets.forEach((text,i)=>presets.append(button(['동작 칭찬','호흡·범위','불편 확인'][i],()=>note.value=text)));
      const mission=make('select','');
      mission.setAttribute('aria-label','개인 미션');
      mission.append(Object.assign(make('option','개인 미션 없음'),{value:''}));
      rows.forEach((routine,index)=>mission.append(Object.assign(make('option','개인 미션 · '+routine.name),{value:String(index),selected:/^\s*\[미션\]/.test(routine.note||'')})));
      const status=make('p','','fit-sheet-status');
      status.setAttribute('role','status');
      const publish=button('리포트 발행',async ()=>{
        if(!coachActive()||!dialog.open||(!rows.length&&!note.value.trim())){status.textContent='루틴 또는 코멘트를 입력해 주세요.';return;}
        publish.disabled=true;
        status.textContent='발행 중…';
        if(!await activateCoach(member,date)){status.textContent='회원 기록을 열 수 없어요.';publish.disabled=false;return;}
        const signature=JSON.stringify((current.routines||[]).map(r=>[r.id,r.name,String(r.weight||''),String(r.sets),r.reps,r.note]));
        const base=Date.now()*100;
        const missionIndex=mission.value===''?-1:Number(mission.value);
        const feedback=note.value.trim();
        const plan=rows.map(item=>({...item}));
        const saved=await updateAndSave(data=>{
          const latest=(data.routines||[]).map(r=>[r.id,r.name,String(r.weight||''),String(r.sets),r.reps,r.note]);
          if(JSON.stringify(latest)!==signature)throw Error('루틴이 변경되었습니다.');
          const edits=plan.map((item,index)=>{
            const text=String(item.note||'').replace(/^\s*\[미션\]\s*/,'');
            const update={weight:item.weight,note:(index===missionIndex?'[미션] ':'')+text};
            const sets=Math.min(20,Math.max(1,Math.trunc(Number(item.sets))));
            return {item,update,newRoutine:{...item,...update,id:base+index,sets:String(sets),completedSets:Array(sets).fill(false)}};
          });
          if(edits.length){
            if(usingCurrent){
              const byId=new Map(edits.map(({item,update})=>[item.id,update]));
              data.routines=data.routines.map(r=>byId.has(r.id)?{...r,...byId.get(r.id)}:r);
            }else data.routines=edits.map(edit=>edit.newRoutine);
          }
          if(feedback)data.feedback={...(data.feedback||{}),workout:feedback,time:nowTimeStr()};
        });
        if(!dialog.open)return;
        status.textContent=saved?'발행 완료. 회원 화면에 반영됐어요.':'발행에 실패했어요. 다른 곳에서 루틴을 수정했다면 일지를 다시 열어주세요.';
        publish.disabled=saved;
        if(saved){content.append(button('회원 전용 링크 복사',()=>copyMemberLink(member.name)));loadTrainerOverview();}
      },'primary');
      content.append(presets,note,mission,publish,status,button('기존 루틴 편집기 열기',()=>{dialog.close();openExistingCoachPage(member,'routine');}));
    }catch{if(dialog.open)content.replaceChildren(make('p','루틴을 불러오지 못했어요. 다시 열어주세요.'));}
  }

  function foodReply(member) {
    const date=coachDate||selectedDate;
    const {dialog,content}=sheet(member.name+' · 식단 답장');
    const summary=make('p','식단 기록을 불러오는 중…');
    content.append(summary);
    withMember(member.name,date).then(data=>{
      if(!dialog.open)return;
      summary.replaceChildren(...foodKeys.filter(key=>hasMemberMealRecord(data.diet?.[key])).map(key=>{
        const item=data.diet[key];
        return make('span',({breakfast:'아침',lunch:'점심',dinner:'저녁',snack:'간식'})[key]+' · '+(item.desc||'사진 또는 영양 기록'));
      }));
      if(!summary.children.length)summary.textContent='선택 날짜에 확인할 식단 기록이 없어요.';
      const status=make('p','');status.setAttribute('role','status');
      const presets=[['👍 아주 좋아요','👍 기록을 꾸준히 잘 남겨주셨어요.'],['🥩 단백질 추가 팁','🥩 다음 끼니에 달걀, 두부, 생선이나 살코기 같은 단백질 식품을 곁들여 보세요.']];
      const controls=presets.map(([label,message])=>button(label,async ()=>{
        controls.forEach(control=>control.disabled=true);
        status.textContent='답장 저장 중…';
        const active=await activateCoach(member,date);
        const ok=active&&await updateAndSave(record=>{
          record.feedback={...(record.feedback||{}),diet:message,time:nowTimeStr()};
        });
        if(dialog.open)status.textContent=ok?'답장을 저장했어요.':'답장을 저장하지 못했어요.';
        if(ok)loadTrainerOverview();else controls.forEach(control=>control.disabled=false);
      }));
      content.append(...controls,status,button('상세 식단과 사진 보기',()=>{dialog.close();openExistingCoachPage(member,'feedback');}));
    }).catch(()=>{if(dialog.open)summary.textContent='식단을 불러오지 못했어요.';});
  }

  async function outcome(member,preloaded) {
    const {dialog,content}=sheet(member.name+' · 누적 성과');
    content.textContent='기록을 모으는 중…';
    try{
      const result=preloaded||await apiPost({action:'memberInsights',...coachContext(member.name,coachDate||selectedDate)});
      if(!dialog.open)return;
      if(result.status!=='success')throw Error('memberInsights');
      const pt=result.pt||{}, initial=result.inbody?.[0], latest=result.inbody?.at(-1);
      const lines=[
        '수업 이용 · '+(Number(pt.total)>0?Number(pt.used||0)+' / '+pt.total+'회':'등록 전'),
        '체형 변화 · '+(initial&&latest?'체중 '+initial.weight+' → '+latest.weight+'kg · 체지방률 '+initial.fat+' → '+latest.fat+'%':'측정 기록 없음'),
        '다음 플랜 · '+(result.goal?.note||pt.note||'다음 상담에서 설정'),
        '출석률은 예정 수업과 실제 출석 데이터가 필요해요.'
      ];
      for(const exercise of (result.progress||[]).slice(0,3)){
        const points=exercise.points||[];
        if(points.length>1)lines.splice(1,0,exercise.name+' · '+points[0].weight+' → '+points.at(-1).weight+'kg');
      }
      content.replaceChildren(...lines.map(line=>make('p',line,'fit-callout')));
      content.append(button('성과 요약 복사',async()=>{await copyTextSafe(member.name+' 회원님 성과 요약\n'+lines.join('\n'));showToast('성과 요약을 복사했어요.');},'primary'));
    }catch{if(dialog.open)content.textContent='성과를 불러오지 못했어요.';}
  }

  function row(member,status,actions) {
    const card=make('article','','fit-coach-row');
    const heading=make('div','','fit-coach-row-heading');
    heading.append(make('strong',member.name+' 회원님'),make('span',status,'fit-pill'));
    const controls=make('div','','fit-filter-row');
    actions.forEach(([label,action,style])=>controls.append(button(label,action,style)));
    card.append(heading,controls);
    return card;
  }
  function renderRoster() {
    const root=id('fitCoachRoster');
    if(!root)return;
    const query=id('fitRosterSearch').value.trim().toLowerCase();
    const byName=new Map(coachItems.map(item=>[item.name,item]));
    const members=[...new Set([...registryMembers,...byName.keys()])].map(name=>byName.get(name)||{name});
    root.replaceChildren();
    for(const member of members){
      if(query&&!member.name.toLowerCase().includes(query))continue;
      if(rosterFilter==='pending'&&(!byName.has(member.name)||member.feedbackDone))continue;
      if(rosterFilter==='care'&&(!byName.has(member.name)||!needsCare(member)))continue;
      root.append(row(member,!byName.has(member.name)?'현황 확인 중':member.feedbackDone?'기록 답변 있음':'미발행',[
        ['성과',()=>outcome(member)],['일지',()=>publisher(member),'primary']
      ]));
    }
    if(!root.children.length)root.append(make('p','조건에 맞는 회원이 없어요.'));
  }
  function renderCoach() {
    if(!coachNav||!coachActive())return;
    const done=coachItems.filter(m=>m.feedbackDone).length;
    const count=coachItems.length;
    id('fitCoachPercent').textContent=count?Math.round(done/count*100)+'%':'—';
    id('fitCoachDone').textContent=count?done+' / '+count+'명 답변 있음':'회원 현황 확인 중';
    id('fitDietJump').textContent='식단 대기 '+dietQueue().length+'명';
    id('fitCareJump').textContent='케어 필요 '+coachItems.filter(needsCare).length+'명';
    const timeline=id('fitCoachTimeline');
    timeline.replaceChildren();
    const upcoming=coachItems.slice().sort((a,b)=>Number(b.activeToday)-Number(a.activeToday)||Number(a.feedbackDone)-Number(b.feedbackDone));
    for(const member of upcoming)timeline.append(row(member,member.feedbackDone?'답변 있음':member.activeToday?'기록 도착':'미발행',[
      ['5분 전 브리핑',()=>briefing(member)],['30초 발행 ▶',()=>publisher(member),'primary']
    ]));
    if(!timeline.children.length)timeline.append(make('p','회원이 등록되면 일지 작성 카드를 보여드려요.'));
    const diet=id('fitDietQueue');diet.replaceChildren(...dietQueue().map(member=>row(member,'식단 대기',[['식단 확인·답장',()=>foodReply(member),'primary']])));
    if(!diet.children.length)diet.append(make('p','답장을 기다리는 식단 기록이 없어요.'));
    const care=id('fitCareQueue');care.replaceChildren(...coachItems.filter(needsCare).map(member=>row(member,careDays(member)===null?'기록 없음':careDays(member)+'일 미기록',[
      ['안부용 링크 복사',()=>copyMemberLink(member.name)],['성과 요약',()=>outcome(member)]
    ])));
    if(!care.children.length)care.append(make('p','4일 이상 미기록인 회원이 없어요.'));
    renderRoster();renderCoachNav();
  }
  async function scanRenewals() {
    if(!coachActive())return;
    const root=id('fitRenewals'),date=coachDate||selectedDate,password=trainerPassword;
    const scan={date,password};renewalScan=scan;
    const list=coachItems.slice();
    root.textContent='수업 등록 정보를 확인하고 있어요…';
    const matches=[];let cursor=0,errors=0;
    await Promise.all(Array.from({length:Math.min(3,list.length)},async ()=>{
      while(cursor<list.length&&renewalScan===scan&&coachActive()){
        const member=list[cursor++];
        try{
          const result=await apiPost({action:'memberInsights',...coachContext(member.name,date),password});
          if(result.status!=='success')throw Error('insights');
          const total=Number(result.pt?.total)||0, remaining=total-(Number(result.pt?.used)||0);
          if(total>0&&remaining<=2)matches.push({member,result,remaining:Math.max(0,remaining)});
        }catch{errors++;}
      }
    }));
    if(renewalScan!==scan||!coachActive()||coachDate!==date||trainerPassword!==password)return;
    root.replaceChildren(...matches.sort((a,b)=>a.remaining-b.remaining).map(({member,result,remaining})=>row(member,'잔여 '+remaining+'회',[
      ['누적 성과 보기',()=>outcome(member,result),'primary']
    ])));
    if(!matches.length)root.append(make('p','조회한 회원 중 2회 이하 남은 회원이 없어요.'));
    if(errors)root.append(make('p','일부 수업 정보를 불러오지 못했어요.'));
  }
  function setupCoach() {
    const root=id('trainerView'), oldNav=id('trainerAppNav');
    if(!root||!oldNav)return;
    const work=make('div','','fit-coach-work');work.id='fitCoachWork';
    const today=make('section','');today.id='fitCoach-today';
    today.innerHTML='<section class="fit-coach-hero"><span>선택일 리포트 발행률</span><strong id="fitCoachPercent">—</strong><p id="fitCoachDone">회원 현황 확인 중</p><div class="fit-filter-row"><button type="button" id="fitDietJump">식단 대기</button><button type="button" id="fitCareJump">케어 필요</button></div></section><h2>회원별 일지</h2><p class="fit-context-note">선택한 날짜의 회원 기록 기준</p><div id="fitCoachTimeline"></div>';
    today.querySelector('#fitDietJump').onclick=()=>goCoach('diet');
    today.querySelector('#fitCareJump').onclick=()=>goCoach('care');
    const diet=make('section','');diet.id='fitCoach-diet';diet.hidden=true;
    diet.innerHTML='<h2>식단 피드백</h2><div id="fitDietQueue"></div>';
    const care=make('section','');care.id='fitCoach-care';care.hidden=true;
    care.innerHTML='<h2>잠수·재등록</h2><p class="fit-context-note">최근 4일 이상 운동·식단 미기록 기준</p><div id="fitCareQueue"></div><h2>수업 종료 임박</h2><div id="fitRenewals"></div>';
    care.insertBefore(button('잔여 2회 이하 회원 조회',scanRenewals),care.querySelector('#fitRenewals'));
    work.append(today,diet,care);
    const dashboard=id('trainerDashboardSection');dashboard.closest('[data-trainer-page]').before(work);
    const roster=make('section','','fit-soft-card');
    roster.innerHTML='<h2>회원 검색</h2><input id="fitRosterSearch" type="search" aria-label="회원 이름 검색" placeholder="회원 이름 검색"><div class="fit-filter-row"></div><div id="fitCoachRoster"></div>';
    id('trainerMembersSection').prepend(roster);
    roster.querySelector('input').oninput=renderRoster;
    for(const [key,label] of [['all','전체'],['pending','미발행'],['care','집중 케어']]){
      const filters=roster.querySelector('.fit-filter-row');
      const control=button(label,()=>{
        rosterFilter=key;[...filters.children].forEach(b=>b.setAttribute('aria-pressed',String(b===control)));renderRoster();
      });control.setAttribute('aria-pressed',String(key==='all'));filters.append(control);
    }
    const registry=id('memberRegistryList');
    if(registry)new MutationObserver(renderRoster).observe(registry,{childList:true});
    coachNav=make('nav','','fit-coach-nav');
    coachNav.setAttribute('aria-label','코치 앱 메뉴');
    for(const [key,label,icon] of coachPages){
      const control=button('',()=>goCoach(key));
      control.dataset.coachTab=key;
      control.innerHTML='<i aria-hidden="true" class="fa-solid '+icon+'"></i><span>'+label+'</span>';
      coachNav.append(control);
    }
    document.body.append(coachNav);
    document.body.classList.add('fit-experience-ready');
    renderCoachNav();
  }

  window.fitExperience={memberData,memberInsights,coachOverview:(items,date)=>{
    if(coachDate!==date){renewalScan=null;id('fitRenewals')?.replaceChildren();}
    coachItems=items;coachDate=date;renderCoach();
  },coachTab};
  document.addEventListener('DOMContentLoaded',()=>{setupMember();setupCoach();});
})();
