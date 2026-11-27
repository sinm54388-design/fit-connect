const kstDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

const datePattern = '오늘|어제|20\\d{2}[-./]\\d{1,2}[-./]\\d{1,2}|\\d{1,2}월\\s*\\d{1,2}일|\\d{1,2}/\\d{1,2}';
const dateAtStart = new RegExp('^(' + datePattern + ')(?=[\\s.,:：]|$)');
const compact = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const escapePattern = (value) => value.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&');

function memberAtStart(text, names) {
  const candidates = names.flatMap((name) => {
    const normalized = compact(String(name));
    if (!normalized) return [];
    const pattern = Array.from(normalized, escapePattern).join('\\s*');
    const match = text.match(new RegExp('^' + pattern + '(?=[\\s,:：]|(?:\\s*회원(?:님)?|\\s*님)(?=[\\s,:：]|$)|$)', 'iu'));
    return match ? [{ name, prefix: match[0], length: normalized.length }] : [];
  }).sort((a, b) => b.length - a.length);
  if (candidates[0] && candidates[1]?.length === candidates[0].length) {
    throw new Error('이름이 같은 회원이 있어요. 회원 상세 화면에서 등록해 주세요.');
  }
  if (candidates.length) return candidates[0];
  if (names.length) throw new Error('첫 부분의 회원 이름만 확인해 주세요. 운동 기록은 그대로 두면 돼요.');
  const first = text.match(/^([^\s,:：]+?)(?:님)?(?=[\s,:：]|$)/u);
  return first ? { name: first[1].trim(), prefix: first[0] } : null;
}

const statToken = /맨몸|체중|(?:\d+(?:[.,]\d+)?)\s*(?:킬로그램|킬로|키로|kg|세트|셋트|셋|sets?|번|회|reps?)?/giu;
const statStart = /(?:맨몸|체중)(?=\s|\d)|\d+(?:[.,]\d+)?(?=\s*(?:kg|킬로|키로|회|번|reps?|세트|셋|sets?))|(?<=\s)\d+(?:[.,]\d+)?(?=\s|[×xX*\/]|$)/iu;

function parseSets(entry, name) {
  const fields = {};
  const bare = [];
  let guessed = 0;
  let offset = 0;
  for (const token of entry.matchAll(statToken)) {
    if (!/^[\s×xX*]+$|^$/.test(entry.slice(offset, token.index))) {
      throw new Error(name + '의 숫자를 확인해 주세요. 중량 · 횟수 · 세트 순서로 적으면 돼요.');
    }
    offset = token.index + token[0].length;
    const value = token[0].trim().toLowerCase();
    const number = Number(value.match(/^\d+(?:[.,]\d+)?/)?.[0].replace(',', '.'));
    let field;
    if (value === '맨몸' || value === '체중' || /(?:kg|킬로그램|킬로|키로)$/.test(value)) field = 'weight';
    else if (/(?:회|번|reps?)$/.test(value)) field = 'reps';
    else if (/(?:세트|셋트|셋|sets?)$/.test(value)) field = 'count';
    if (!field) bare.push({ number, at: token.index });
    else {
      if (Object.hasOwn(fields, field)) throw new Error(name + '의 세트가 여러 종류라면 /로 나눠 적어주세요.');
      fields[field] = { number: Number.isNaN(number) ? null : number, at: token.index };
    }
  }
  if (!/^[\s×xX*]*$/.test(entry.slice(offset))) throw new Error(name + '에 적은 운동 수치를 확인해 주세요.');
  const order = ['weight', 'reps', 'count'];
  for (const value of bare) {
    const next = order.find((field) => !Object.hasOwn(fields, field) &&
      order.every((other) => !fields[other] || (order.indexOf(other) < order.indexOf(field) ? fields[other].at < value.at : fields[other].at > value.at)));
    if (!next) throw new Error(name + '의 숫자를 중량 · 횟수 · 세트 순서로 적어주세요.');
    fields[next] = value;
    guessed++;
  }
  const weightMissing = !fields.weight;
  const weight = fields.weight?.number ?? null, reps = fields.reps?.number, count = fields.count?.number ?? 1;
  if ((weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 1200)) ||
      !Number.isInteger(reps) || reps < 1 || reps > 999 || !Number.isInteger(count) || count < 1 || count > 30) {
    throw new Error(name + '의 중량과 횟수를 확인해 주세요. 예: 15 15 4 또는 맨몸 12번 3셋');
  }
  return { sets: Array.from({ length: count }, () => ({ weight_kg: weight, reps, ...(weightMissing ? { weightMissing: true } : {}) })), guessed: guessed > 0 };
}

export function parseWorkout(text, now = new Date(), names = []) {
  text = text.normalize('NFKC').trim();
  if (!text) throw new Error('회원 이름과 운동 내용을 입력해 주세요.');
  const leading = text.match(dateAtStart);
  let body = leading ? text.slice(leading[0].length).replace(/^[\s.,:：]+/, '') : text;
  const head = memberAtStart(body, names);
  if (!head?.name || head.name.length > 50) throw new Error('회원 이름을 입력해 주세요.');
  body = body.slice(head.prefix.length).replace(/^\s*(?:회원(?:님)?|님)(?=\s|[,:：]|$)/u, '').replace(/^[\s,:：]+/, '');
  const trailing = body.match(dateAtStart);
  const rawDate = (leading || trailing)?.[1];
  if (trailing) body = body.slice(trailing[0].length).replace(/^[\s.,:：]+/, '');
  body = body.replace(/^(?:PT\s*)?수업(?:\s*[.,:：]\s*|\s+|$)/iu, '').trim();

  const today = kstDate.format(now);
  let date = today;
  if (rawDate === '어제') date = kstDate.format(new Date(now.getTime() - 86400000));
  else if (rawDate && rawDate !== '오늘') {
    const parts = rawDate.match(/\d+/g);
    date = (parts.length === 2 ? [today.slice(0, 4), ...parts] : parts).map((part) => part.padStart(2, '0')).join('-');
  }
  const day = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error('수업 날짜를 확인해 주세요.');

  const clauses = body.split(/(?<!\d)[,，]|[,，](?!\d)|[;\n]+|\.(?=\s|$)|(?<=(?:세트|셋트|셋))\s+(?=[가-힣A-Za-z])/u).map((clause) => clause.trim()).filter(Boolean);
  const exercises = [];
  let videoExercise = '';
  let guessed = false;
  for (const clause of clauses) {
    if (/^영상(?:은|:|：|\s)/.test(clause)) {
      videoExercise = clause.replace(/^영상(?:은|:|：)?\s*/, '').trim();
      continue;
    }
    if (/^(?:올려|등록해|저장해)\s*(?:줘|주세요)?[.!]?$/u.test(clause)) continue;
    const first = clause.search(statStart);
    if (first < 1) throw new Error('‘' + clause.slice(0, 32) + '’에서 운동 이름과 수치를 찾지 못했어요.');
    const name = clause.slice(0, first).trim();
    if (!name || name.length > 100 || /[-+−]$/.test(name) || exercises.some((item) => compact(item.name) === compact(name))) {
      throw new Error('운동 이름과 세트를 확인해 주세요. 같은 종목의 세트는 /로 나눠 적을 수 있어요.');
    }
    const sets = clause.slice(first).split('/').flatMap((entry) => {
      const result = parseSets(entry, name);
      guessed ||= result.guessed;
      return result.sets;
    });
    if (sets.length > 30 || exercises.length >= 15) throw new Error('수업 한 건에 최대 15종목, 종목당 30세트를 적을 수 있어요.');
    exercises.push({ name, sets });
  }
  if (!exercises.length) throw new Error('등록할 운동을 한 종목 이상 입력해 주세요.');
  const matchingVideo = exercises.find(({ name }) => compact(name) === compact(videoExercise));
  return { member: head.name, date, exercises, videoExercise: matchingVideo?.name ?? videoExercise, guessed };
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
  const { member, date } = lesson;
  const [{ ids, plan, videoId, index }, record] = await Promise.all([sessionIds(lesson), api.read(member, date)]);
  const before = storedRoutines(record);
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
        placeholder="테스트회원 스쿼트 40 10 3"></textarea>
      <details class="text-[13px] text-[#475569]">
        <summary class="font-bold text-[#1E3A8A]">입력 예시</summary>
        <p class="mt-1">테스트회원 스쿼트 40 10 3</p>
        <p class="mt-1">테스트회원 어제 숄더프레스 15키로 15번 4셋, 푸시업 맨몸 12회 3세트</p>
      </details>
      <label for="coach-quick-video" class="block text-[13px] font-bold">운동 영상 <span class="font-medium text-[#475569]">선택</span></label>
      <input id="coach-quick-video" type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" class="w-full text-[14px]">
      <p id="coach-quick-attachment" aria-live="polite" class="hidden rounded-xl border border-[#DCE5EE] bg-[#F8FAFC] p-3 text-[13px]"></p>
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
  const attachment = find('attachment');
  function showAttachment(message) {
    attachment.textContent = message;
    attachment.classList.toggle('hidden', !message);
  }
  const describeFile = (file) => file.name + ' · ' + (file.size / 1_000_000).toFixed(1) + 'MB';
  const announceError = (error) => {
    setStatus(error?.status === 403 ? '코치 로그인이 만료됐어요. FIT-CONNECT에서 다시 로그인해 주세요.' : error.message || '잠시 후 다시 시도해 주세요.');
  };
  let draft, memberList, preparation, busy = false;
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
    try { parsed = parseWorkout(input.value, new Date(), memberList?.members); } catch { return; }
    const current = selector.value;
    selector.replaceChildren(option('종목 선택', ''), ...parsed.exercises.map(({ name }) => option(name, name)));
    selector.value = parsed.videoExercise || (parsed.exercises.length === 1 ? parsed.exercises[0].name : current);
    label.classList.toggle('hidden', parsed.exercises.length === 1 && !parsed.videoExercise);
  }
  input.addEventListener('input', () => { clearReview(); updateTarget(); });
  fileInput.addEventListener('change', () => {
    clearReview();
    updateTarget();
    preparation?.controller.abort();
    preparation = null;
    const file = fileInput.files[0];
    if (!file) { showAttachment(''); return; }
    if (!file.size || file.size > 100_000_000 || !api.validVideo(file)) {
      showAttachment('첨부 실패 · 100MB 이하의 MP4, MOV, WebM 영상을 선택해 주세요.');
      return;
    }
    const readyMessage = '영상 첨부됨 · ' + describeFile(file) + ' · 등록 내용 확인 → 일지에 등록을 누르면 전송됩니다.';
    showAttachment(readyMessage);
    if (!api.prepare) return;
    const controller = new AbortController();
    const job = { file, controller, report: null };
    job.promise = api.prepare(file, controller.signal, (stage, percent) => {
      if (preparation === job) showAttachment(describeFile(file) + ' · ' + stage + (Number.isFinite(percent) ? ' ' + percent + '%' : '') + ' · 일지 등록 시 전송');
      job.report?.(stage, percent);
    }).catch(() => ({ file })).then((result) => {
      if (preparation === job && !controller.signal.aborted) showAttachment(readyMessage);
      return result;
    });
    preparation = job;
  });
  selector.addEventListener('change', clearReview);
  function renderReview(lesson, file) {
    const details = [lesson.member + ' · ' + lesson.date];
    if (lesson.guessed) details.push('단위가 없는 숫자는 중량(kg) · 횟수 · 세트 순서로 읽었어요.');
    for (const { name, sets } of lesson.exercises) {
      const descriptions = sets.map(({ weight_kg, reps, weightMissing }) => (weightMissing ? '중량 미입력' : weight_kg === null ? '맨몸' : weight_kg + 'kg') + ' ' + reps + '회');
      details.push(name + ' · ' + (descriptions.every((item) => item === descriptions[0])
        ? descriptions[0] + ' × ' + sets.length + '세트' : descriptions.join(' / ')));
    }
    if (file) details.push('영상 · ' + lesson.videoExercise + ' · ' + describeFile(file) + ' (일지에 등록을 누르면 전송 시작)');
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
      lock(true);
      setStatus('회원 정보를 확인하고 있어요.');
      memberList = await api.members(kstDate.format(new Date()));
      if (!Array.isArray(memberList?.members) || !Array.isArray(memberList?.nativeMembers)) throw new Error('회원 목록을 확인하지 못했어요.');
      const lesson = parseWorkout(input.value, new Date(), memberList.members);
      if (!memberList.nativeMembers.includes(lesson.member)) throw new Error('이 회원은 회원 상세 화면에서 일지를 등록해 주세요.');
      const file = fileInput.files[0];
      if (file) {
        if (!file.size || file.size > 100_000_000 || !api.validVideo(file)) throw new Error('100MB 이하의 MP4, MOV, WebM 영상을 첨부해 주세요.');
        updateTarget();
        lesson.videoExercise = selector.value || (lesson.exercises.length === 1 && !lesson.videoExercise ? lesson.exercises[0].name : '');
        if (!lesson.videoExercise) throw new Error('영상이 연결될 운동을 선택해 주세요.');
      } else if (lesson.videoExercise) {
        throw new Error('연결할 운동 영상을 첨부해 주세요.');
      }
      const prepared = preparation?.file === file ? preparation : null;
      const onStage = (name, percentage) => setStatus(name + (percentage ? ' · ' + percentage + '%' : ''));
      draft = { lesson, file, prepared, upload: { onStage, ...(prepared ? { prepared: prepared.promise } : {}) } };
      renderReview(lesson, file);
      setStatus(file ? '첨부 확인 완료 · 일지에 등록을 누르면 영상 전송이 시작됩니다.' : '등록 내용을 확인한 뒤 일지에 등록을 눌러 주세요.');
    } catch (error) { announceError(error); }
    finally { lock(false); }
  });
  save.addEventListener('click', async () => {
    if (!draft || busy) return;
    lock(true);
    setStatus('일지에 등록하고 있어요.');
    try {
      const { lesson, file, upload, prepared } = draft;
      const started = performance.now();
      if (prepared) prepared.report = upload.onStage;
      const result = await saveCoachSession(lesson, file, upload, api);
      const transferred = upload.timing?.transfer;
      const duration = (milliseconds) => (milliseconds / 1000).toFixed(1) + '초';
      const timing = Number.isFinite(transferred)
        ? ' 영상 ' + (upload.timing.sentBytes / 1_000_000).toFixed(1) + 'MB 전송 ' + duration(transferred) + ' · 등록까지 ' + duration(performance.now() - started)
        : '';
      setStatus((result.alreadySaved ? '이미 등록된 수업이에요.' : lesson.member + ' 회원의 일지에 등록했어요.') + timing);
      save.classList.add('hidden');
      draft = null;
      fileInput.value = '';
      preparation = null;
      showAttachment(file ? '영상 등록 완료 · ' + describeFile(file) : '');
      api.onSaved(lesson.date);
    } catch (error) { announceError(error); }
    finally {
      if (preparation) preparation.report = null;
      lock(false);
    }
  });
}
