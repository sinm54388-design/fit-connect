(() => {
  const id = name => document.getElementById(name);
  const make = (tag, text = '', className = '') => Object.assign(document.createElement(tag), {textContent:text, className});
  const button = (label, action) => Object.assign(make('button',label,'fit-action'), {type:'button',onclick:action});
  const exerciseKey = name => String(name || '').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  const retakePrefix = '__FIT_RETAKE__:';
  const completedLine = '✓ 자세 과제 완료';
  const weeklyPrefix = '__FIT_WEEKLY_COACH__:';
  const homeworkPrefix = '__FIT_NEXT_WORKOUT__:';
  const koreaDate = date => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(date);
  const videoDate = video => {
    const date = new Date(video.createdAt || video.date || '');
    return Number.isFinite(+date) ? koreaDate(date) : '';
  };
  let retake = null;
  let refreshVideoTasks = () => {};

  function feedbackParts(value) {
    const lines = String(value || '').split('\n');
    const match = lines[0].match(/^(\d{1,2}):([0-5]\d) · /);
    const seconds = match ? Number(match[1])*60+Number(match[2]) : null;
    const completed=lines.find(line=>line===completedLine||/^✓ 자세 과제 완료 · \d{4}-\d{2}-\d{2}$/.test(line));
    return {seconds, text:lines.filter(line=>line!==completed).join('\n'), complete:Boolean(completed),
      completedAt:completed?.slice((completedLine+' · ').length)||''};
  }
  const clock = seconds => Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  function retakeId(video) {
    const first = String(video.question || '').split('\n')[0];
    return first.startsWith(retakePrefix) ? first.slice(retakePrefix.length) : '';
  }
  function videoQuestion(video) {
    return retakeId(video) ? String(video.question).split('\n').slice(1).join('\n') : video.question;
  }
  function signedInVideos() {
    return formVideoListOwner === videoListOwner() ? formVideos : [];
  }
  async function fetchVideos(context) {
    const auth = {member:context.member,date:context.date,token:context.token};
    if (context.mode==='trainer') auth.password=context.password;
    const results = await Promise.allSettled([
      directVideoRequest({...auth,action:'directVideoList'}),
      cachedExtraRead({...auth,action:'listFormVideos'})
    ]);
    const successful = results.filter(result=>result.status==='fulfilled' && result.value.status==='success');
    return {videos:successful.flatMap(result=>result.value.videos||[]),partial:successful.length!==results.length};
  }

  function videoPlayer(video, seconds) {
    const panel = make('div','','fit-drill-player');
    if (video.fileId) {
      panel.append(button(seconds == null?'영상 재생':clock(seconds)+'부터 보기',event=>playPrivateVideo(video.fileId,event.currentTarget,seconds)));
    } else {
      panel.innerHTML = videoLink(video);
      if (!panel.childElementCount) panel.textContent='재생할 수 있는 영상이 없어요.';
    }
    return panel;
  }
  function showRetake(before) {
    if (videoUploadActive) { showToast('현재 영상을 먼저 보내주세요.'); return; }
    const file = id('memberVideoFile');
    if (file.files.length) { showToast('선택한 영상부터 보내거나 파일 선택을 취소해 주세요.'); return; }
    const name = id('memberVideoName');
    name.value = before.name;
    retake = {id:before.id,key:exerciseKey(before.name),owner:videoListOwner()};
    id('fitRetakeHint').hidden=false;
    openMemberVideoUpload();
  }
  function cancelRetake() {
    retake=null;
    id('fitRetakeHint').hidden=true;
  }
  function uploadQuestion(name, question) {
    if (retake?.owner !== videoListOwner() || retake.key !== exerciseKey(name)) return question;
    return retakePrefix+retake.id+'\n'+question;
  }
  function showComparison(before, after) {
    const {content} = window.fitExperience.sheet(after.name+' · 자세 비교');
    const pair = make('div','','fit-drill-comparison');
    for (const [label,video,seconds] of [['교정 전',before,feedbackParts(before.feedback).seconds],['재촬영',after,null]]) {
      const side = make('section');
      side.append(make('h3',label),videoPlayer(video,seconds));
      pair.append(side);
    }
    content.append(pair,make('p',feedbackParts(before.feedback).text,'fit-callout'));
  }
  function mountVideoTools() {
    const videos = signedInVideos();
    const root = id(currentMode==='trainer'?'trainerFormVideos':'memberFormVideos');
    if (!root) return;
    for (const card of root.children) {
      const video = videos.find(item=>String(item.id||item.fileId)===card.dataset.videoKey);
      if (!video) continue;
      const before = videos.find(item=>item!==video && String(item.id)===retakeId(video) && exerciseKey(item.name)===exerciseKey(video.name));
      const existing=card.querySelector('.fit-drill-video-tools');
      if (existing && existing.dataset.before===String(before?.id||'')) continue;
      const tools = make('div','','fit-drill-video-tools');
      tools.dataset.before=String(before?.id||'');
      const reply = feedbackParts(video.feedback);
      if (currentMode==='trainer') {
        const input = id('feedback-'+video.id);
        if (!input) continue;
        if (input.value===input.defaultValue && reply.complete) input.value=input.defaultValue=reply.text;
        tools.append(button('현재 재생 위치 넣기',()=>{
          const player = card.querySelector('video');
          if (!player?.readyState) { showToast('영상을 먼저 재생한 뒤 구간을 선택하세요.'); return; }
          input.value=(clock(Math.floor(player.currentTime))+' · '+input.value.replace(/^\d{1,2}:[0-5]\d · /,'')).slice(0,input.maxLength);
          input.focus();
        }));
        if (before) {
          const complete = Object.assign(make('input'),{type:'checkbox',checked:reply.complete});
          complete.dataset.postureComplete='';
          const label = make('label',' 자세 과제 완료');
          label.prepend(complete);
          tools.append(label);
        }
      } else if (reply.seconds !== null && video.fileId) {
        tools.append(button(clock(reply.seconds)+'부터 보기',()=>{
          const box = card.querySelector('[data-video-player]');
          const player = box.querySelector('video');
          if (player?.readyState) {
            player.currentTime = Math.min(reply.seconds,player.duration||reply.seconds);
            player.play().catch(()=>{});
          } else {
            const play=box.querySelector('button');
            if (play) playPrivateVideo(video.fileId,play,reply.seconds);
          }
        }));
      }
      if (before) tools.append(button('교정 전·재촬영 비교',()=>showComparison(before,video)));
      if (existing) existing.remove();
      if (tools.childElementCount) card.append(tools);
    }
    if (currentMode==='member') renderRoutinePrompts();
  }
  function formatFeedback(input) {
    const text = feedbackParts(input.value).text.trim();
    if (!text || /^\d{1,2}:[0-5]\d ·$/.test(text)) return '';
    const video=signedInVideos().find(item=>'feedback-'+item.id===input.id);
    const existing=feedbackParts(video?.feedback);
    const complete=input.closest('article').querySelector('[data-posture-complete]')?.checked??existing.complete;
    if (!complete) return text;
    const date=existing.completedAt||koreaDate(new Date());
    const marker=completedLine+' · '+date;
    return text.slice(0,2000-marker.length-1)+'\n'+marker;
  }
  function postureTasks(videos) {
    const byExercise = new Map();
    for (const video of videos.slice().sort((a,b)=>String(b.createdAt||b.date||'').localeCompare(String(a.createdAt||a.date||'')))) {
      const key=exerciseKey(video.name);
      if (!byExercise.has(key) && video.feedback) byExercise.set(key,video);
    }
    return [...byExercise.values()].filter(video=>!feedbackParts(video.feedback).complete);
  }
  function renderRoutinePrompts() {
    if (currentMode!=='member') return;
    const videos = signedInVideos();
    const tasks = postureTasks(videos);
    for (const slot of id('memberRoutineList').querySelectorAll('[data-posture-exercise]')) {
      const task = tasks.find(video=>exerciseKey(video.name)===exerciseKey(slot.dataset.postureExercise) &&
        (!videoDate(video)||videoDate(video)<=selectedDate));
      const followUp = task && videos.find(video=>retakeId(video)===String(task.id));
      const signature = JSON.stringify([task?.id,task?.feedback,followUp?.id]);
      if (slot.dataset.signature===signature) continue;
      slot.dataset.signature=signature;
      slot.hidden=!task;
      slot.replaceChildren();
      if (!task) continue;
      const reply = feedbackParts(task.feedback);
      slot.append(make('strong','코치 자세 피드백'),make('p',reply.text),videoPlayer(task,reply.seconds));
      if (followUp) {
        slot.append(make('p','재촬영 영상 확인 대기'),button('교정 전·재촬영 비교',()=>showComparison(task,followUp)));
      } else if (task.id) {
        slot.append(button('같은 각도로 다시 찍어 보내기',()=>showRetake(task)));
      }
    }
  }

  async function briefingDetails(content, member, date, previous, current, dialog) {
    const checkIn=readDailyCheckin(current);
    const mood={good:'좋음',normal:'보통',tired:'피곤함'}[checkIn.mood];
    const completed=(previous?.data?.routines||[]).filter(item=>item.completedSets?.some(Boolean));
    content.append(make('p','지난 수행'+(previous?' · '+previous.date:'')+' / '+(completed.map(item=>
      item.name+' '+(item.weight?item.weight+'kg':'맨몸')+' × '+item.reps+'회 · '+item.completedSets.filter(Boolean).length+'세트'
    ).join(' / ')||'완료 기록 없음'),'fit-callout'));
    content.append(make('p','오늘 컨디션 · '+(mood||'미체크')));
    const posture=make('p','자세 과제 불러오는 중…');
    content.append(posture);
    const {videos,partial}=await fetchVideos({mode:'trainer',member:member.name,date,password:trainerPassword});
    if (!dialog.open || currentMode!=='trainer') return;
    const tasks=postureTasks(videos);
    posture.textContent='자세 과제 · '+(tasks.length?tasks.map(video=>video.name+' — '+feedbackParts(video.feedback).text).join(' / '):partial?'일부 영상 조회 실패':'확인할 과제 없음');
  }

  const workoutStoragePrefix = 'fitWorkoutQueue:v1:';
  const workoutQueues = new Map();
  const queueKey = context => {
    let hash=2166136261;
    for (const char of context.token || '') hash=Math.imul(hash^char.charCodeAt(0),16777619);
    return workoutStoragePrefix+(hash>>>0);
  };
  function workoutQueue(context) {
    const key=queueKey(context);
    if (!workoutQueues.has(key)) {
      let saved={};
      try {
        const entry=JSON.parse(localStorage.getItem(key)||'null');
        if (entry?.expires>Date.now() && entry.changes) saved=entry.changes;
        else if (entry) localStorage.removeItem(key);
      } catch {}
      workoutQueues.set(key,saved);
    }
    return workoutQueues.get(key);
  }
  function persistWorkoutQueue(context, queue) {
    try {
      if (Object.keys(queue).length) localStorage.setItem(queueKey(context),JSON.stringify({expires:Date.now()+86400000,changes:queue}));
      else localStorage.removeItem(queueKey(context));
      return true;
    } catch { return false; }
  }
  function putWorkoutChange(context, change, field) {
    const queue=workoutQueue(context);
    const key=JSON.stringify([context.date,String(change.id),field]);
    queue[key]={...change,date:context.date};
    const persisted=persistWorkoutQueue(context,queue);
    setSaveStatus('saving',persisted?'기기에 임시 저장 · 서버에 동기화 중':'서버에 동기화 중 · 화면을 유지해 주세요');
    clearTimeout(syncTimer);
    syncTimer=setTimeout(flushWorkoutQueue,500);
  }
  function applyWorkoutChanges(routines) {
    const context=getSaveContext();
    if (context.mode!=='member' || !context.token) return;
    for (const change of Object.values(workoutQueue(context))) {
      if (change.date!==context.date) continue;
      const routine=routines.find(item=>String(item.id)===String(change.id));
      if (!routine) continue;
      if (change.index!==undefined) {
        if (!Array.isArray(routine.completedSets)) routine.completedSets=[];
        if (change.index<Number(routine.sets)) routine.completedSets[change.index]=change.checked;
      } else { routine.weight=change.weight; routine.reps=change.reps; }
    }
  }
  let syncing=false;
  let syncTimer;
  function showWorkoutSyncStatus() {
    const status=id('fitWorkoutSync');
    if (!status || currentMode!=='member') return;
    const context=getSaveContext();
    status.hidden=!context.token||!Object.keys(workoutQueue(context)).length;
  }
  async function flushWorkoutQueue() {
    const context=getSaveContext();
    if (syncing || context.mode!=='member' || !context.token || !hasMemberAccess()) return;
    const queue=workoutQueue(context);
    const pending=Object.entries(queue);
    if (!pending.length) return;
    showWorkoutSyncStatus();
    if (!navigator.onLine) return;
    syncing=true;
    let failed=false;
    const sameMember=()=>currentMode==='member'&&activeMemberName===context.member&&memberToken===context.token;
    try {
      const dates=[...new Set(pending.map(([,change])=>change.date))];
      for (const date of dates) {
        if (!sameMember()) break;
        const batch=pending.filter(([,change])=>change.date===date && queue[pendingKey(change)]===change);
        const sets=batch.filter(([,change])=>change.index!==undefined);
        const actual=batch.filter(([,change])=>change.index===undefined);
        if (sets.length) {
          const result=await apiPost({action:'setProgressBatch',member:context.member,token:context.token,date,
            changes:sets.map(([, {id,index,checked}])=>({id,index,checked}))});
          if (result.status!=='success') throw Error(result.message||'세트 저장 실패');
          acknowledge(sets);
        }
        if (actual.length && sameMember()) {
          const saved=await updateAndSave(data=>{
            for (const [,change] of actual) {
              const routine=data.routines.find(item=>String(item.id)===String(change.id));
              if (routine) { routine.weight=change.weight; routine.reps=change.reps; }
            }
          },{...context,date},false);
          if (!saved) throw Error('실제 운동 기록 저장 실패');
          acknowledge(actual);
        }
      }
    } catch {
      failed=true;
      if (sameMember()) setSaveStatus('error','운동 기록 동기화 대기 · 운동 화면에서 다시 시도');
    } finally {
      syncing=false;
      if (sameMember()) {
        showWorkoutSyncStatus();
        if (!failed) {
          if (Object.keys(queue).length) flushWorkoutQueue();
          else { setSaveStatus('saved','운동 기록을 저장했어요.'); loadDataFromCloud(true); }
        }
      } else if (currentMode==='member') {
        flushWorkoutQueue();
      }
    }
    function acknowledge(batch) {
      for (const [key,change] of batch) if (queue[key]===change) delete queue[key];
      persistWorkoutQueue(context,queue);
    }
    function pendingKey(change) {
      return JSON.stringify([change.date,String(change.id),change.index??'actual']);
    }
  }
  function recordSet(routine,index,checked) {
    const context=getSaveContext();
    if (!context.token) return false;
    putWorkoutChange(context,{id:routine.id,index,checked},index);
    showWorkoutSyncStatus();
    if (checked) startRest();
    return true;
  }
  function actualWorkout(routineId) {
    const context=getSaveContext();
    if (!context.token || workflowReadyKey!==workflowContextKey()) return;
    const routine=appData.routines.find(item=>String(item.id)===String(routineId));
    if (!routine) return;
    const {dialog,content}=window.fitExperience.sheet(routine.name+' · 운동 기록');
    const previous=historyRecordKey===workflowContextKey()?historyData.previous?.[routine.name.trim().toLowerCase()]:null;
    const pending=workoutQueue(context)[JSON.stringify([context.date,String(routineId),'actual'])];
    const weight=Object.assign(make('input'),{type:'number',min:'0',max:'9999',step:'0.01',
      value:pending?.weight??(routine.completedSets?.some(Boolean)?routine.weight:previous?.weight)??routine.weight??''});
    const reps=Object.assign(make('input'),{type:'number',min:'1',max:'999',step:'1',
      value:pending?.reps??(routine.completedSets?.some(Boolean)?routine.reps:previous?.reps)??routine.reps??'',required:true});
    const form=make('form','','fit-sheet-content');
    const weightLabel=make('label','실제 중량 (kg)');
    const repsLabel=make('label','실제 횟수 (회)');
    weightLabel.append(weight);
    repsLabel.append(reps);
    const save=Object.assign(make('button','기록 저장','fit-action primary'),{type:'submit'});
    form.append(weightLabel,repsLabel,save);
    if (previous) content.append(make('p','이전 완료 기록 · '+(previous.weight?previous.weight+'kg':'맨몸')+' × '+previous.reps+'회'));
    form.onsubmit=event=>{
      event.preventDefault();
      if (!isCurrentSaveContext(context) || context.token!==memberToken) return;
      putWorkoutChange(context,{id:routine.id,weight:weight.value,reps:reps.value},'actual');
      showWorkoutSyncStatus();
      dialog.close();
      renderMemberRoutines(appData.routines);
    };
    content.append(form);
  }
  let restEnd=0;
  let restTimer;
  function startRest() {
    clearInterval(restTimer);
    restEnd=Date.now()+60000;
    updateRest();
    restTimer=setInterval(updateRest,250);
  }
  function updateRest() {
    const remaining=Math.max(0,Math.ceil((restEnd-Date.now())/1000));
    id('fitWorkoutRest').hidden=false;
    id('fitWorkoutRestTime').textContent=remaining?'세트 휴식 · '+clock(remaining):'휴식 완료';
    if (!remaining) clearInterval(restTimer);
  }
  function stopRest() {
    clearInterval(restTimer);
    restEnd=0;
    const panel=id('fitWorkoutRest');
    if (panel) panel.hidden=true;
  }

  function weekStart(date) {
    const weekday = new Date(date+'T12:00:00Z').getUTCDay();
    return shiftDay(date,-((weekday+6)%7));
  }
  function shiftDay(date,days) {
    return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
  }
  function weeklyLines(insights, videos, start, date, partial) {
    const week=insights?.weekly;
    const days=insights?.careSummary?.workoutDays??week?.current?.workoutDays??week?.current?.days;
    const changes=(insights?.progress||[]).flatMap(exercise=>{
      const points=(exercise.points||[]).filter(point=>point.date>=start && point.date<=date);
      const first=points[0], last=points.at(-1);
      return first && first!==last && first.weight!==last.weight?[exercise.name+' '+first.weight+' → '+last.weight+'kg']:[];
    }).slice(0,3);
    const reviewed=videos.filter(video=>{
      const reply=feedbackParts(video.feedback);
      const finished=reply.completedAt||videoDate(video);
      return reply.complete && finished>=start && finished<=date;
    });
    return [
      days==null?'운동 기록 확인 불가':'운동 '+(Array.isArray(days)?days.length:days)+'일',
      ...changes,
      '자세 과제 완료 '+reviewed.length+'개'+(partial?' · 일부 영상 조회 실패':'')
    ];
  }
  async function weeklyCard(member, date) {
    const context={...getSaveContext(),member,date};
    if (context.mode==='member' && member!==activeMemberName) return;
    const start=weekStart(date);
    const {dialog,content}=window.fitExperience.sheet('주간 코칭 · '+member);
    content.append(make('p',start+' ~ '+date),make('p','기록을 불러오는 중…'));
    const auth={member,date,token:context.token};
    if (context.mode==='trainer') auth.password=context.password;
    const [stats,videos,record]=await Promise.allSettled([
      cachedExtraRead({...auth,action:'memberInsights'}),
      fetchVideos(context),
      fetchLatest({...context,date:start},true)
    ]);
    const current=()=>dialog.open&&currentMode===context.mode&&
      (context.mode==='trainer'?trainerPassword===context.password:activeMemberName===member&&memberToken===context.token);
    if (!current()) return;
    const result=stats.status==='fulfilled'&&stats.value.status==='success'?stats.value:null;
    const videoResult=videos.status==='fulfilled'?videos.value:{videos:[],partial:true};
    const lines=weeklyLines(result,videoResult.videos,start,date,videoResult.partial);
    const published=record.status==='fulfilled'?(record.value.memos||[]).filter(memo=>memo.from==='trainer'&&
      String(memo.text||'').startsWith(weeklyPrefix)).at(-1):null;
    let previousCard=null;
    if (published) {
      try { previousCard=JSON.parse(published.text.slice(weeklyPrefix.length)); } catch {}
    }
    const note=typeof previousCard?.note==='string'?previousCard.note:'';
    const report=make('section','','fit-drill-week');
    const savedLines=context.mode==='member'&&Array.isArray(previousCard?.lines)?previousCard.lines:lines;
    const end=context.mode==='member'&&previousCard?.date?previousCard.date:date;
    report.append(make('h3',start+' ~ '+end),...savedLines.map(line=>make('p',line)));
    content.replaceChildren(report);
    if (context.mode==='member') {
      if (note) report.append(make('strong','다음 주에 집중할 한 가지'),make('p',note));
      if (record.status==='rejected') content.append(make('p','코치 코멘트를 불러오지 못했어요.'));
      content.append(button('지난주 보기',()=>weeklyCard(member,shiftDay(start,-1))));
      return;
    }
    const input=Object.assign(make('textarea'),{rows:3,maxLength:400,value:note,placeholder:'다음 주에 집중할 한 가지'});
    input.setAttribute('aria-label','다음 주에 집중할 한 가지');
    const status=make('p','','fit-sheet-status');
    status.setAttribute('role','status');
    const publish=button('회원 앱에 보내기',async()=>{
      if (!current() || !input.value.trim()) { status.textContent='코치 코멘트를 입력해 주세요.'; return; }
      publish.disabled=true;
      status.textContent='저장 중…';
      const memo={id:'weekly-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),from:'trainer',
        text:weeklyPrefix+JSON.stringify({date,lines,note:input.value.trim()}),time:nowTimeStr()};
      const saved=await updateAndSave(data=>{ if(!data.memos.some(item=>item.id===memo.id))data.memos.push(memo); },{...context,date:start},false);
      if (!current()) return;
      status.textContent=saved?'회원 앱에 보냈어요.':'저장하지 못했어요. 다시 시도해 주세요.';
      publish.disabled=false;
    });
    const copy=button('카톡용 문구 복사',async()=>{
      try {
        await copyTextSafe([member+' 회원님 주간 코칭',start+' ~ '+date,...lines,
          ...(input.value.trim()?['다음 주 · '+input.value.trim()]:[])].join('\n'));
        status.textContent='복사했어요.';
      } catch { status.textContent='복사하지 못했어요.'; }
    });
    content.append(input,publish,copy,status);
  }

  function addHomeworkForm(content, member, date, mission, note, routines) {
    const context={...getSaveContext(),member};
    const section=make('details','','fit-drill-homework');
    const dateInput=Object.assign(make('input'),{type:'date',min:shiftDay(date,1),value:shiftDay(date,1)});
    const dateLabel=make('label','숙제 날짜');
    dateLabel.append(dateInput);
    const status=make('p','','fit-sheet-status');
    status.setAttribute('role','status');
    const send=button('선택한 날짜에 숙제 보내기',async()=>{
      if (currentMode!=='trainer'||trainerPassword!==context.password||!dateInput.value||!dateInput.checkValidity()) return;
      const exercise=mission.value===''?null:routines[Number(mission.value)];
      const instructions=[exercise?.name,note.value.trim()].filter(Boolean).join(' · ');
      if (!instructions) { status.textContent='개인 미션을 고르거나 코치 코멘트를 적어주세요.'; return; }
      send.disabled=true;
      status.textContent='저장 중…';
      const memo={id:'homework-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),from:'trainer',
        text:homeworkPrefix+instructions,time:nowTimeStr()};
      const saved=await updateAndSave(data=>{ if (!data.memos.some(item=>item.id===memo.id))data.memos.push(memo); },
        {...context,date:dateInput.value},false);
      status.textContent=saved?'회원의 운동 화면에 숙제를 보냈어요.':'저장하지 못했어요. 다시 시도해 주세요.';
      send.disabled=false;
    });
    section.append(make('summary','다음 운동 숙제 보내기'),dateLabel,send,status);
    content.append(section);
  }
  function renderHomework(data) {
    const panel=id('fitWorkoutHomework');
    if (!panel) return;
    const memo=(data?.memos||[]).filter(item=>item.from==='trainer'&&String(item.text||'').startsWith(homeworkPrefix)).at(-1);
    panel.hidden=!memo;
    if (memo) panel.replaceChildren(make('strong','코치가 보낸 운동 숙제'),make('p',memo.text.slice(homeworkPrefix.length)));
    else panel.replaceChildren();
  }

  function setup() {
    refreshVideoTasks=mountVideoTools;
    const form=id('memberVideoName').form;
    const hint=make('div','','fit-drill-video-tools');
    hint.id='fitRetakeHint';
    hint.hidden=true;
    hint.append(make('p','교정 전 영상과 같은 각도에서 촬영해 주세요.'),button('재촬영 연결 취소',cancelRetake));
    form.prepend(hint);
    form.addEventListener('reset',cancelRetake);
    const upload=id('memberVideoUploadStatus');
    const retry=button('선택한 영상 다시 보내기',()=>form.requestSubmit());
    retry.hidden=true;
    upload.after(retry);
    new MutationObserver(()=>{
      retry.hidden=!upload.textContent.startsWith('업로드 오류') || !id('memberVideoFile').files.length;
    }).observe(upload,{childList:true});
    id('memberVideoFile').addEventListener('change',()=>{retry.hidden=true;});
    const sync=button('운동 기록 동기화 다시 시도',flushWorkoutQueue);
    sync.id='fitWorkoutSync';sync.hidden=true;
    const rest=make('div','','fit-drill-rest');
    rest.id='fitWorkoutRest';rest.hidden=true;
    const time=make('strong');
    time.id='fitWorkoutRestTime';
    rest.append(time,button('닫기',stopRest));
    const homework=make('div','','fit-drill-cue');
    homework.id='fitWorkoutHomework';
    homework.hidden=true;
    id('memberRoutineList').before(homework,sync,rest);
    id('memberInsightsSection').prepend(button('주간 코칭 카드',()=>weeklyCard(activeMemberName,selectedDate)));
    window.addEventListener('online',flushWorkoutQueue);
    if (currentMode==='member' && hasMemberAccess()) showWorkoutSyncStatus();
  }
  window.fitCoaching={videoQuestion,feedbackParts,formatFeedback,uploadQuestion,refreshVideoTasks:()=>refreshVideoTasks(),
    resetVideoContext:()=>{ if (retake && retake.owner!==videoListOwner()) cancelRetake(); if(currentMode!=='member')stopRest(); },
    renderRoutinePrompts,briefingDetails,applyWorkoutChanges,showWorkoutSyncStatus,recordSet,flushWorkoutQueue,actualWorkout,
    weeklyCard,addHomeworkForm,renderHomework,
    isCoachingMemo:memo=>[weeklyPrefix,homeworkPrefix].some(prefix=>String(memo?.text||'').startsWith(prefix))};
  document.addEventListener('DOMContentLoaded',setup);
})();
