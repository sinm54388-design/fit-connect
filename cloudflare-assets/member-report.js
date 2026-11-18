(() => {
  const byId = id => document.getElementById(id);
  const mealNames = {breakfast:'아침', lunch:'점심', dinner:'저녁', snack:'간식'};
  const dayNames = ['월','화','수','목','금','토','일'];
  const ready = () => currentMode === 'member' && workflowReadyKey === workflowContextKey();
  const pending = new Map();
  let mirrorQueue = Promise.resolve();
  let openSheet;
  let missionPreview;
  let week;
  let weekVisible = false;

  function pendingChecks() {
    return Object.fromEntries([...pending.values()]
      .filter(entry => entry.context === workflowContextKey())
      .map(({field,value}) => [field,value]));
  }

  function previewCheck(field, value) {
    const context = workflowContextKey(), key = context+'|'+field;
    const entry = {context,field,value};
    pending.set(key,entry);
    return () => { if (pending.get(key) === entry) pending.delete(key); };
  }

  function mirrorCheck(task) {
    mirrorQueue = mirrorQueue.then(task).catch(error => console.warn('상태 체크 빠른 조회 갱신 실패',error));
  }

  function openMeal(meal) {
    if (!ready() || !Object.hasOwn(mealNames,meal)) return;
    const dialog = byId('fitMealSheet'), section = byId('meal-section-'+meal);
    const editor = byId('meal-'+meal+'-editor');
    if (!dialog || !section || !editor || dialog.open) return;
    const anchor = document.createComment('meal sheet origin');
    section.before(anchor);
    openSheet = {meal,section,anchor,trigger:document.activeElement};
    dialog.querySelector('[data-sheet-body]').append(section);
    byId('fitMealSheetTitle').textContent = mealNames[meal]+' 식단 기록';
    mealStatus(meal,'');
    mealEditorOpen.add(meal);
    editor.classList.remove('hidden');
    dialog.showModal();
    dialog.querySelector('.report-sheet-panel').scrollTop = 0;
  }

  function restoreMeal() {
    if (!openSheet) return;
    const {meal,section,anchor,trigger} = openSheet;
    openSheet = null;
    anchor.replaceWith(section);
    mealEditorOpen.delete(meal);
    if (trigger?.isConnected) trigger.focus({preventScroll:true});
  }

  function closeMeal(expected) {
    if (!openSheet || (expected && expected !== openSheet.meal)) return;
    const dialog = byId('fitMealSheet');
    if (dialog.open) dialog.close();
    restoreMeal();
  }

  function mealStatus(meal,message) {
    if (openSheet?.meal===meal) byId('fitMealSheetStatus').textContent = message;
  }

  function quickMeal() {
    if (!ready()) return;
    const meal = ['breakfast','lunch','dinner'].find(key => !hasMemberMealRecord(appData.diet?.[key]));
    if (meal) openMeal(meal);
    else navigateMemberPage('diet');
  }

  function workoutTotals(routines) {
    let planned = 0, done = 0;
    for (const routine of routines) {
      const sets = Number(routine?.sets);
      const total = Number.isSafeInteger(sets) && sets>0 ? sets : 0;
      planned += total;
      const checks = Array.isArray(routine?.completedSets) ? routine.completedSets : [];
      done += checks.slice(0,total).filter(Boolean).length;
    }
    return {planned,done,percent:planned ? Math.round(done/planned*100) : 0};
  }

  function weekDates(date) {
    const monday = new Date(date+'T12:00:00Z');
    monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
    return dayNames.map((_,index) => {
      const day = new Date(monday);
      day.setUTCDate(day.getUTCDate()+index);
      return day.toISOString().slice(0,10);
    });
  }

  function workoutGroup(name) {
    const value = String(name || '').toLowerCase();
    if (/스쿼트|런지|데드리프트|레그|힙|카프|squat|lunge|deadlift|leg|calf/.test(value)) return 1;
    if (/벤치|푸시업|푸쉬업|로우|풀다운|풀업|랫풀|렛풀|숄더|컬|딥스|체스트|삼두|이두|bench|push.?up|row|pull|shoulder|curl|dip|chest/.test(value)) return 0;
    return 2;
  }

  function smoothPath(points) {
    return points.map(([x,y],i) => {
      if (!i) return 'M'+x+' '+y;
      const [px,py] = points[i-1], middle = (px+x)/2;
      return 'C'+middle+' '+py+' '+middle+' '+y+' '+x+' '+y;
    }).join(' ');
  }

  function drawWeek(data) {
    const root = byId('reportRhythm');
    if (!root || !week) return;
    const dates = week.dates.filter(date => date <= selectedDate);
    const counts = [], groups = [0,0,0];
    for (const date of dates) {
      const record = date === selectedDate ? data : week.records.get(date);
      if (!record) { counts.push(null); continue; }
      const routines = record.routines || [];
      counts.push(workoutTotals(routines).done);
      for (const exercise of routines) groups[workoutGroup(exercise.name)] += workoutTotals([exercise]).done;
    }
    const maximum = Math.max(1,...counts);
    const segments = [];
    for (let i=0; i<counts.length; i++) {
      if (counts[i] === null) continue;
      if (i===0 || counts[i-1]===null) segments.push([]);
      segments.at(-1).push([16+i*48,82-64*counts[i]/maximum]);
    }
    root.querySelector('[data-week-lines]').innerHTML = segments.map(points => {
      const path = smoothPath(points), ends = points.at(-1);
      const fill = points.length > 1 ? '<path fill="url(#reportCurveFill)" d="'+path+' L'+ends[0]+' 88 H'+points[0][0]+' Z"/>' : '';
      return fill+'<path fill="none" stroke="url(#reportCurve)" stroke-width="3" stroke-linecap="round" d="'+path+'"/>'+
        points.map(([x,y]) => '<circle cx="'+x+'" cy="'+y+'" r="3.5" fill="#2563eb"/>').join('');
    }).join('');
    root.querySelector('[data-week-days]').textContent = '운동 '+counts.filter(n => n>0).length+'일';
    root.querySelector('[data-week-values]').innerHTML = dayNames.map((day,i) =>
      '<span>'+day+'<small>'+(i<counts.length ? counts[i] ?? '—' : '·')+'</small></span>').join('');
    const total = groups.reduce((sum,n) => sum+n,0);
    const labels = ['상체','하체','코어·기타'];
    root.querySelector('[data-week-stack]').innerHTML = groups.map((n,i) =>
      n ? '<i style="flex:'+n+'" data-group="'+i+'"></i>' : '').join('');
    root.querySelector('[data-week-legend]').textContent = total
      ? labels.map((label,i) => label+' '+Math.round(groups[i]/total*100)+'%').join(' · ')
      : week.loading ? '이번 주 기록을 확인하고 있어요.' : week.partial ? '일부 기록을 불러오지 못했어요.' : '완료한 세트가 쌓이면 비중을 보여드려요.';
    root.querySelector('[data-week-status]').textContent = week.loading ? '지난 기록 확인 중' : week.partial ? '조회된 기록 기준' : '완료 세트 기준';
  }

  async function loadWeek(model, context) {
    if (model.requested) return;
    model.requested = true;
    const dates = model.dates.filter(date => date < context.date);
    model.loading = !!dates.length;
    let index = 0;
    await Promise.all(Array.from({length:Math.min(2,dates.length)},async () => {
      while (week === model && ready() && index < dates.length) {
        const date = dates[index++];
        try {
          const previous = {...context,date};
          const hit = viewedRecordCache.get(recordCacheKey(previous));
          model.records.set(date,hit ?? await sharedDailyRead(previous));
        } catch {
          model.partial = true;
        }
      }
    }));
    model.loading = false;
    if (week === model && ready() && model.key === workflowContextKey()) drawWeek(appData);
  }

  function dashboardRoutines(data) {
    const routines = data.routines || [];
    if (missionPreview?.context !== workflowContextKey()) return routines;
    return routines.map(r => String(r.id) === missionPreview.id ? {...r,completedSets:missionPreview.completedSets} : r);
  }

  function refresh(data) {
    const rings = byId('reportActivityRings');
    if (!rings || currentMode !== 'member') return;
    const values = data && ready() ? data : null;
    const routines = values ? dashboardRoutines(values) : [];
    const checkin = values ? {...readDailyCheckin(values),...pendingChecks()} : {};
    const summary = values ? memberRecordBalance({...values,routines,memos:[],dailyCheckin:checkin}) : null;
    const workout = workoutTotals(routines);
    const calories = values ? Object.keys(mealNames).reduce((sum,meal) => sum+(Number(values.diet?.[meal]?.cal)||0),0) : 0;
    const target = Number(byId('memberTargetCalorieText')?.textContent.replace(/[^0-9.]/g,'')) || 2100;
    const caloriePercent = Math.max(0,Math.min(100,Math.round(calories/target*100)));
    const numbers = [summary?.score,values ? caloriePercent : null,values ? workout.percent : null];
    rings.querySelectorAll('[data-ring]').forEach((ring,i) => ring.style.strokeDashoffset = String(100-(numbers[i] ?? 0)));
    const write = (id,value) => { byId(id).textContent = value; };
    write('reportRingScore',numbers[0] ?? '—');
    ['기록','칼로리','루틴'].forEach((label,i) => {
      byId('reportRingLegend').children[i].textContent = label+' '+(numbers[i] == null ? '—' : numbers[i]+'%');
    });
    write('reportWorkoutValue',values ? workout.percent+'%' : '—');
    write('reportWorkoutDetail',values && workout.planned ? workout.done+'/'+workout.planned+'세트 완료 ›' : '수업일지 보기 ›');
    write('reportCalorieValue',values ? calories.toLocaleString() : '—');
    write('reportCalorieDetail','목표 '+target.toLocaleString()+' kcal ›');
    byId('reportWorkoutBar').style.width = workout.percent+'%';
    byId('reportCalorieBar').style.width = caloriePercent+'%';
    const verify = byId('reportVerify'), verified = checkin.workout === 'done';
    verify.querySelector('span').textContent = verified ? '운동 인증 완료' : selectedDate===getLocalDateStr() ? '오늘 운동 인증하기' : '선택한 날 운동 인증하기';
    verify.disabled = !values || verified;
    verify.classList.toggle('is-complete',verified);
    const eligible = routines.filter(item => item?.id != null && workoutTotals([item]).planned>0);
    const mission = eligible.find(item => /미션|숙제/.test(String(item.note || ''))) || eligible[0];
    const missionDone = mission && workoutTotals([mission]).percent===100;
    const missionButton = byId('reportMission');
    missionButton.querySelector('strong').textContent = mission ? '개인 미션 · '+mission.name : '개인 미션';
    missionButton.querySelector('small').textContent = missionDone ? '완료한 운동이에요.' : mission ? '이 운동의 모든 세트 완료' : '코치 루틴이 등록되면 표시돼요.';
    missionButton.disabled = !values || !mission || missionDone || missionPreview?.context === workflowContextKey();
    missionButton.dataset.id = mission ? String(mission.id) : '';
    if (!values) { week = null; resetWeek(); return; }
    const key = workflowContextKey();
    if (week?.key !== key) week = {key,dates:weekDates(selectedDate),records:new Map(),loading:true};
    if (weekVisible) loadWeek(week,getSaveContext());
    drawWeek({...values,routines});
  }

  function resetWeek() {
    const root = byId('reportRhythm');
    for (const part of ['lines','days','stack','legend','values']) root.querySelector('[data-week-'+part+']').replaceChildren();
    root.querySelector('[data-week-status]').textContent = '기록 확인 중';
  }

  async function completeMission() {
    if (!ready()) return;
    const id = byId('reportMission').dataset.id;
    const routine = (appData.routines || []).find(r => String(r.id)===id);
    const planned = routine && workoutTotals([routine]).planned;
    if (!planned) return;
    const context = getSaveContext();
    const completedSets = Array(planned).fill(true);
    const preview = {id,context:workflowContextKey(),completedSets};
    missionPreview = preview;
    refresh(appData);
    const saved = await updateAndSave(record => {
      const current = (record.routines || []).find(r => String(r.id)===id);
      if (current && workoutTotals([current]).planned===planned) current.completedSets = completedSets.slice();
    });
    if (missionPreview === preview) missionPreview = null;
    if (!isCurrentSaveContext(context)) return;
    refresh(appData);
    if (saved && workoutTotals([(appData.routines || []).find(r => String(r.id)===id)]).percent===100)
      showToast('개인 미션을 완료했어요.');
  }

  function setup() {
    const home = byId('memberHomePage'), hero = home?.querySelector('.member-goal-hero');
    if (!home || !hero) return;
    const group = hero.querySelector('.fit-hero-content');
    if (!group) return;
    document.body.classList.add('member-report-enabled');
    const score = hero.querySelector('.fit-score');
    score.hidden = true;
    const rings = document.createElement('button');
    rings.type = 'button'; rings.id = 'reportActivityRings';
    rings.setAttribute('aria-label','기록 달성률 계산 기준 보기');
    rings.innerHTML = '<svg viewBox="0 0 124 124" aria-hidden="true">'+
      [54,42,30].map((r,i) => '<circle class="report-ring-track" cx="62" cy="62" r="'+r+'"/><circle class="report-ring-progress" data-ring="'+i+'" cx="62" cy="62" r="'+r+'" pathLength="100"/>').join('')+
      '</svg><strong id="reportRingScore">—</strong>';
    rings.onclick = () => score.click();
    group.append(rings);
    const legend = document.createElement('div');
    legend.id = 'reportRingLegend'; legend.innerHTML = '<span></span><span></span><span></span>';
    byId('fcGreet').after(legend);
    const briefing = byId('fcCoachCard');
    if (briefing) hero.append(briefing);
    const verify = document.createElement('button');
    verify.type = 'button'; verify.id = 'reportVerify';
    verify.innerHTML = '<i aria-hidden="true" class="fa-solid fa-check"></i><span>오늘 운동 인증하기</span>';
    verify.onclick = () => saveDailyCheckin('workout','done');
    hero.append(verify);

    const summaries = document.createElement('div');
    summaries.id = 'reportSummaries';
    summaries.innerHTML = '<button type="button" class="report-workout-card"><span>운동 달성률</span><strong id="reportWorkoutValue">—</strong><div class="report-summary-track"><i id="reportWorkoutBar"></i></div><small id="reportWorkoutDetail"></small></button>'+
      '<button type="button" class="report-calorie-card"><span>오늘 칼로리</span><strong id="reportCalorieValue">—</strong><div class="report-summary-track"><i id="reportCalorieBar"></i></div><small id="reportCalorieDetail"></small></button>';
    summaries.children[0].onclick = () => navigateMemberPage('workout');
    summaries.children[1].onclick = () => navigateMemberPage('diet');
    home.append(summaries);
    const rhythm = document.createElement('section');
    rhythm.id = 'reportRhythm'; rhythm.className = 'report-card';
    rhythm.innerHTML = `<header><h2>주간 운동 리듬</h2><span data-week-days></span></header>
      <svg viewBox="0 0 320 90" role="img" aria-label="요일별 완료 운동 세트">
        <defs><linearGradient id="reportCurve"><stop stop-color="#1d4ed8"/><stop offset="1" stop-color="#14b8a6"/></linearGradient>
        <linearGradient id="reportCurveFill" x2="0" y2="100%"><stop stop-color="#60a5fa" stop-opacity=".32"/><stop offset="1" stop-color="#5eead4" stop-opacity=".06"/></linearGradient></defs>
        <path class="report-curve-grid" d="M16 82H304 M16 50H304 M16 18H304"/><g data-week-lines></g>
      </svg><div class="report-week-values" data-week-values></div>
      <div class="report-week-caption"><strong>이번 주 자극 부위 비중</strong><span data-week-status></span></div>
      <div class="report-week-stack" data-week-stack></div><p class="report-week-legend" data-week-legend></p>
      <button type="button" id="reportMission"><i aria-hidden="true" class="fa-solid fa-bolt"></i><span><strong>개인 미션</strong><small>코치 루틴 확인 중</small></span><b aria-hidden="true">›</b></button>`;
    rhythm.querySelector('button').onclick = completeMission;
    home.append(rhythm);
    const checkin = byId('memberDailyCheckin');
    if (checkin) {
      home.append(checkin);
      checkin.querySelector('h3').textContent = '오늘 상태 체크';
    }
    home.querySelector('[data-record-card="diet"] .home-record-heading span').lastChild.textContent = ' 오늘의 식단';
    const tabLabels = {workout:'수업일지', feedback:'메모'};
    for (const [key,label] of Object.entries(tabLabels)) document.querySelector('[data-member-tab="'+key+'"] span').textContent = label;
    byId('memberExerciseSection').querySelector('.member-page-heading h2').textContent = '수업일지';
    byId('memberFeedbackPage').querySelector('.member-page-heading h2').textContent = '코치 메모';
    const dialog = document.createElement('dialog');
    dialog.id = 'fitMealSheet';
    dialog.setAttribute('aria-labelledby','fitMealSheetTitle');
    dialog.innerHTML = '<div class="report-sheet-panel"><div class="report-sheet-handle" aria-hidden="true"></div><header><h2 id="fitMealSheetTitle">식단 기록</h2><button type="button" aria-label="식단 기록 닫기" autofocus>×</button></header><p id="fitMealSheetStatus" role="status"></p><div data-sheet-body></div></div>';
    dialog.querySelector('button').onclick = closeMeal.bind(null,undefined);
    dialog.addEventListener('close',() => { if (!dialog.open) restoreMeal(); });
    dialog.addEventListener('click',event => { if(event.target===dialog) closeMeal(); });
    byId('memberView').append(dialog);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && currentMode==='member') meta.content = '#f4f6f9';
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry],observer) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        weekVisible = true;
        refresh(ready() ? appData : null);
      },{rootMargin:'260px'}).observe(rhythm);
    } else weekVisible = true;
    refresh(ready() ? appData : null);
  }

  window.fitMemberReport = {refresh,openMeal,quickMeal,closeMeal,mealStatus,previewCheck,pendingChecks,mirrorCheck};
  document.addEventListener('DOMContentLoaded',setup);
})();
