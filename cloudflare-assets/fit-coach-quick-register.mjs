const kstDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

export function parseWorkout(text, now = new Date()) {
  text = text.normalize('NFC').trim();
  if (!text) throw new Error('회원 이름과 운동 내용을 입력해 주세요.');
  const datePattern = '오늘|어제|20[0-9]{2}[-./][0-9]{1,2}[-./][0-9]{1,2}|[0-9]{1,2}월\\s*[0-9]{1,2}일';
  const dated = text.match(new RegExp('^([^\\n,:]+?)\\s+(' + datePattern + ')(?=\\s|[.,:]|$)[\\s.,:]*'));
  const simple = !dated && (text.match(/^([^\n:]{1,80})\s*[:\n]\s*/) || text.match(/^(.{1,50}?\s회원|.{1,50}?님)\s+/));
  const head = dated || simple;
  if (!head) throw new Error('첫 부분을 ‘테스트회원 오늘’처럼 적어주세요. 이름 뒤에 콜론을 써도 돼요.');
  const member = head[1].trim().replace(/\s+회원$|님$/u, '').trim();
  if (!member) throw new Error('회원 이름을 확인해 주세요.');

  const formattedToday = kstDate.format(now);
  let date = formattedToday;
  const rawDate = dated?.[2];
  if (rawDate === '어제') {
    date = kstDate.format(new Date(now.getTime() - 86400000));
  } else if (rawDate && rawDate !== '오늘') {
    const parts = rawDate.match(/\d+/g);
    date = (parts.length === 2 ? [formattedToday.slice(0, 4), ...parts] : parts).map((part) => part.padStart(2, '0')).join('-');
  }
  const day = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date || member.length > 50) {
    throw new Error('회원 이름과 수업 날짜를 확인해 주세요.');
  }
  const body = text.slice(head[0].length).replace(/^수업(?:\s*[.,:]\s*|\s+|$)/, '');
  const clauses = body.split(/[,;\n]+|\.(?=\s|$)/).map((clause) => clause.trim()).filter(Boolean);
  const exercises = [];
  let videoExercise = '';
  const unit = /(?:\d+(?:\.\d+)?)\s*(?:kg|킬로|키로|㎏)|맨몸|\d+\s*(?:회|세트)/giu;
  for (const clause of clauses) {
    if (/^영상(?:은|:)/.test(clause)) {
      videoExercise = clause.replace(/^영상(?:은|:)\s*/, '').trim();
      continue;
    }
    if (/^(?:올려|등록해|저장해)\s*(?:줘|주세요)?[.!]?$/u.test(clause)) continue;
    const firstUnit = clause.search(unit);
    if (firstUnit < 1) throw new Error('‘' + clause.slice(0, 32) + '’에서 운동 이름과 세트 정보를 찾지 못했어요.');
    const name = clause.slice(0, firstUnit).trim();
    if (name.length > 100 || /[-+−]$/.test(name) || exercises.some((item) => item.name === name)) {
      throw new Error('운동 이름과 세트를 확인해 주세요. 같은 종목은 /로 세트를 나눠 적을 수 있어요.');
    }
    const sets = clause.slice(firstUnit).split('/').flatMap((entry) => {
      const reps = [...entry.matchAll(/(\d+)\s*회/g)];
      const counts = [...entry.matchAll(/(\d+)\s*세트/g)];
      const weights = [...entry.matchAll(/(\d+(?:\.\d+)?)\s*(?:kg|킬로|키로|㎏)|맨몸/giu)];
      const remainder = entry.replace(unit, '').replace(/[\s×xX*]+/g, '');
      if (reps.length !== 1 || counts.length > 1 || weights.length !== 1 || remainder) {
        throw new Error(name + '의 무게, 횟수, 세트를 확인해 주세요. 예시는 40kg 10회 3세트예요.');
      }
      const count = Number(counts[0]?.[1] ?? 1);
      if (count < 1 || count > 30) throw new Error(name + '의 세트 수는 1~30으로 입력해 주세요.');
      const weight_kg = weights[0][1] === undefined ? null : Number(weights[0][1]);
      const repetitions = Number(reps[0][1]);
      if (repetitions < 1 || repetitions > 999 || (weight_kg !== null && weight_kg > 1200)) {
        throw new Error(name + '의 중량과 횟수를 확인해 주세요.');
      }
      return Array.from({ length: count }, () => ({ weight_kg, reps: repetitions }));
    });
    if (sets.length > 30 || exercises.length >= 15) throw new Error('수업 한 건에 최대 15종목, 종목당 30세트를 적을 수 있어요.');
    exercises.push({ name, sets });
  }
  if (!exercises.length) throw new Error('등록할 운동을 한 종목 이상 입력해 주세요.');
  return { member, date, exercises, videoExercise };
}

async function sessionIds(lesson) {
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  // Same IDs as the private quick-registration page for this exact lesson.
  const plan = lesson.exercises.map(({ name, sets }) => ({
    name, sets: sets.map(({ weight_kg, reps }) => ({ weight: weight_kg === null ? '' : String(weight_kg), reps: String(reps) })),
  }));
  const root = JSON.stringify([lesson.member, lesson.date, '', plan]);
  const ids = await Promise.all(plan.map(async (_, index) => {
    const bytes = await digest(root + ':routine:' + index);
    return bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0) + 100000000000000;
  }));
  const index = plan.findIndex(({ name }) => name === lesson.videoExercise);
  const video = (await digest(root + ':video:' + index)).slice(0, 16);
  video[6] = (video[6] & 15) | 64;
  video[8] = (video[8] & 63) | 128;
  const hex = Array.from(video, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const videoId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  return { ids, plan, videoId, index };
}

function storedRoutines(record) {
  if (!record?.nativeDaily || (record.routines != null && !Array.isArray(record.routines))) {
    throw new Error('회원 일지 형식을 확인하지 못했어요.');
  }
  const routines = record.routines ?? [];
  if (routines.some((routine) => routine?.id == null)) {
    throw new Error('기존 일지 일부가 자동 추가와 호환되지 않아요. 회원 상세 화면에서 확인해 주세요.');
  }
  return routines;
}

export async function saveCoachSession(lesson, file, upload, api) {
  const { ids, plan, videoId, index } = await sessionIds(lesson);
  const { member, date } = lesson;
  const before = storedRoutines(await api.read(member, date));
  const known = new Map(before.map((routine) => [String(routine.id), routine]));
  const newItems = plan.flatMap(({ name, sets }, order) => known.has(String(ids[order])) ? [] : [{
    id: ids[order], routineType: 'pt', name, weight: sets[0].weight, reps: sets[0].reps,
    sets: String(sets.length), setDetails: sets, completedSets: sets.map(() => true), note: '', videoUrl: '',
  }]);
  if (file) {
    if (index < 0) throw new Error('영상이 연결될 운동을 선택해 주세요.');
    const id = ids[index];
    const existing = known.get(String(id));
    if (existing?.videoId && existing.videoId !== 'direct:' + videoId) {
      throw new Error('이 운동에는 이미 다른 영상이 연결돼 있어요. 회원 상세 화면에서 확인해 주세요.');
    }
    if (!existing?.videoId) {
      upload.id = videoId;
      upload.date = date;
      const attached = await api.upload(file, member, plan[index].name, upload);
      if (attached !== 'direct:' + videoId) throw new Error('영상 등록을 확인하지 못했어요. 다시 시도해 주세요.');
      const latest = storedRoutines(await api.read(member, date)).find((routine) => String(routine.id) === String(id));
      if (latest?.videoId && latest.videoId !== attached) throw new Error('이 운동에 다른 영상이 연결됐어요. 회원 상세 화면을 확인해 주세요.');
      const pending = newItems.findIndex((routine) => routine.id === id);
      const updated = { ...(latest ?? existing ?? newItems[pending]), videoId: attached };
      if (pending >= 0) newItems[pending] = updated;
      else newItems.push(updated);
    }
  }
  if (newItems.length) await api.write(member, date, newItems);
  const after = storedRoutines(await api.read(member, date));
  if (!ids.every((id) => after.some((routine) => String(routine.id) === String(id)))
      || (file && !after.some((routine) => String(routine.id) === String(ids[index]) && routine.videoId === 'direct:' + videoId))) {
    throw new Error('일지에서 등록 결과를 확인하지 못했어요. 같은 내용으로 다시 시도해 주세요.');
  }
  return { alreadySaved: newItems.length === 0 };
}

function option(label, value) { return new Option(label, value); }

export function openCoachQuickRegistration(api) {
  api.open('수업 일지 빠른 등록', `
    <form id="coach-quick-form" class="space-y-3 text-[#111827]">
      <label for="coach-quick-text" class="block text-[13px] font-bold">회원 이름 · 날짜 · 운동 기록</label>
      <textarea id="coach-quick-text" rows="4" maxlength="3500" required
        class="w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-[16px]"
        placeholder="테스트회원 오늘 수업. 스쿼트 40kg 10회 3세트"></textarea>
      <details class="text-[13px] text-[#475569]">
        <summary class="font-bold text-[#1E3A8A]">입력 예시</summary>
        <p class="mt-1">테스트회원 오늘 수업. 스쿼트 40kg 10회 / 45kg 8회, 푸시업 맨몸 12회 3세트</p>
      </details>
      <label for="coach-quick-video" class="block text-[13px] font-bold">운동 영상 <span class="font-medium text-[#475569]">선택</span></label>
      <input id="coach-quick-video" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" class="w-full text-[14px]">
      <label id="coach-quick-target-label" class="hidden text-[13px] font-bold">영상 연결 종목
        <select id="coach-quick-target" class="mt-1 w-full rounded-xl border border-[#E2E8F0] bg-white p-2 text-[16px]"></select>
      </label>
      <button id="coach-quick-review" type="submit" class="tap-scale hero-navy w-full rounded-xl py-3 text-[14px] font-extrabold text-white">등록 내용 확인</button>
      <div id="coach-quick-summary" class="hidden space-y-2 rounded-xl bg-[#EFF6FF] p-3 text-[14px]"></div>
      <button id="coach-quick-save" type="button" class="hidden tap-scale hero-navy w-full rounded-xl py-3 text-[14px] font-extrabold text-white">일지에 등록</button>
      <p id="coach-quick-status" role="status" class="text-[13px] text-[#475569]"></p>
    </form>
  `);
  const form = document.getElementById('coach-quick-form');
  const find = (name) => form.querySelector('#coach-quick-' + name);
  const input = find('text'), fileInput = find('video'), selector = find('target'), label = find('target-label');
  const review = find('review'), summary = find('summary'), save = find('save'), status = find('status');
  const setStatus = (value) => { status.textContent = value; };
  const announceError = (error) => {
    setStatus(error?.status === 403 ? '코치 로그인이 만료됐어요. FIT-CONNECT에서 다시 로그인해 주세요.' : error.message || '잠시 후 다시 시도해 주세요.');
  };
  let draft, busy = false;
  function lock(locked) {
    busy = locked;
    [input, fileInput, selector, review, save].forEach((control) => { control.disabled = locked; });
  }
  function clearReview() {
    draft = null;
    summary.classList.add('hidden');
    save.classList.add('hidden');
    setStatus('');
  }
  function updateTarget() {
    label.classList.add('hidden');
    if (!fileInput.files.length) return;
    let parsed;
    try { parsed = parseWorkout(input.value); } catch { return; }
    const current = selector.value;
    selector.replaceChildren(option('종목 선택', ''), ...parsed.exercises.map(({ name }) => option(name, name)));
    selector.value = parsed.videoExercise || (parsed.exercises.length === 1 ? parsed.exercises[0].name : current);
    label.classList.toggle('hidden', parsed.exercises.length === 1 && !parsed.videoExercise);
  }
  input.addEventListener('input', () => { clearReview(); updateTarget(); });
  fileInput.addEventListener('change', () => { clearReview(); updateTarget(); });
  selector.addEventListener('change', clearReview);
  function renderReview(lesson, file) {
    const details = [lesson.member + ' · ' + lesson.date];
    for (const { name, sets } of lesson.exercises) {
      const descriptions = sets.map(({ weight_kg, reps }) => (weight_kg === null ? '맨몸' : weight_kg + 'kg') + ' ' + reps + '회');
      details.push(name + ' · ' + (descriptions.every((item) => item === descriptions[0])
        ? descriptions[0] + ' × ' + sets.length + '세트' : descriptions.join(' / ')));
    }
    if (file) details.push('영상 · ' + lesson.videoExercise);
    summary.replaceChildren(...details.map((line) => {
      const item = document.createElement('p');
      item.textContent = line;
      return item;
    }));
    summary.classList.remove('hidden');
    save.classList.remove('hidden');
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    clearReview();
    try {
      const lesson = parseWorkout(input.value);
      const file = fileInput.files[0];
      if (file) {
        if (file.size > 100_000_000 || !api.validVideo(file)) throw new Error('100MB 이하의 MP4, MOV, WebM 영상을 첨부해 주세요.');
        lesson.videoExercise = selector.value || (lesson.exercises.length === 1 && !lesson.videoExercise ? lesson.exercises[0].name : '');
        if (!lesson.videoExercise) throw new Error('영상이 연결될 운동을 선택해 주세요.');
      } else if (lesson.videoExercise) {
        throw new Error('연결할 운동 영상을 첨부해 주세요.');
      }
      lock(true);
      setStatus('회원 정보를 확인하고 있어요.');
      const list = await api.members(lesson.date);
      if (!Array.isArray(list?.members) || !Array.isArray(list?.nativeMembers)) throw new Error('회원 목록을 확인하지 못했어요.');
      const matches = list.members.filter((name) => String(name).normalize('NFC').trim().replace(/\s+/g, ' ') === lesson.member);
      if (matches.length !== 1) throw new Error('등록된 회원 이름을 정확히 입력해 주세요.');
      lesson.member = matches[0];
      if (!list.nativeMembers.includes(lesson.member)) throw new Error('이 회원은 회원 상세 화면에서 일지를 등록해 주세요.');
      draft = { lesson, file, upload: { onStage: (name, percentage) => setStatus(name + (percentage ? ' · ' + percentage + '%' : '')) } };
      renderReview(lesson, file);
      setStatus('');
    } catch (error) { announceError(error); }
    finally { lock(false); }
  });
  save.addEventListener('click', async () => {
    if (!draft || busy) return;
    lock(true);
    setStatus('일지에 등록하고 있어요.');
    try {
      const { lesson, file, upload } = draft;
      const result = await saveCoachSession(lesson, file, upload, api);
      setStatus(result.alreadySaved ? '이미 등록된 수업이에요.' : lesson.member + ' 회원의 일지에 등록했어요.');
      save.classList.add('hidden');
      draft = null;
      api.onSaved(lesson.date);
    } catch (error) { announceError(error); }
    finally { lock(false); }
  });
}
