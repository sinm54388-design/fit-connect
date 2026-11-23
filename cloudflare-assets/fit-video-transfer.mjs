const CHUNK_BYTES = 6 * 1024 * 1024;
const RETRY_LIMIT = 2;

export async function sendResumableVideo(file, mime, options, job, transfer, onProgress, report) {
  const endpoint = new URL(options.tusEndpoint);
  const validateLocation = location => {
    const url = new URL(location, endpoint);
    if (url.origin !== endpoint.origin || !url.pathname.startsWith(endpoint.pathname + '/')) {
      throw new Error('이어 올리기 주소를 확인하지 못했어요');
    }
    return url.href;
  };
  const credentials = { 'Tus-Resumable': '1.0.0', 'x-signature': options.uploadToken };
  const request = (method, url, headers, body, start = 0) =>
    transfer(url, body, { ...credentials, ...headers }, (_percent, loaded) => {
      const uploaded = Math.min(file.size, start + loaded);
      onProgress?.(Math.min(99, Math.round(uploaded / file.size * 100)), uploaded, file.size);
    }, method);
  const offset = (response, fallback) => {
    if (response.offset == null && fallback !== undefined) return fallback;
    const value = Number(response.offset);
    if (response.offset == null || !Number.isSafeInteger(value) || value < 0 || value > file.size) {
      throw new Error('이어서 보낼 위치를 확인하지 못했어요');
    }
    return value;
  };
  const checkOffset = async () => {
    const response = await request('HEAD', job.tusUrl);
    if ([404, 410].includes(response.status)) {
      delete job.tusUrl;
      return null;
    }
    if (!response.ok) throw new Error('이어 올리기 확인 실패 (' + response.status + ')');
    return offset(response);
  };

  let sent = 0;
  if (job.tusUrl) {
    job.tusUrl = validateLocation(job.tusUrl);
    sent = await checkOffset() ?? 0;
  }
  if (!job.tusUrl) {
    const encode = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const meta = { bucketName: 'fit-direct-videos', objectName: options.objectName, contentType: mime, cacheControl: '3600' };
    const first = file.slice(0, CHUNK_BYTES);
    const response = await request('POST', endpoint.href, {
      'Upload-Length': String(file.size),
      'Upload-Metadata': Object.entries(meta).map(([key, value]) => key + ' ' + encode(value)).join(','),
      'Content-Type': 'application/offset+octet-stream'
    }, first);
    if (!response.ok || !response.location) return false;
    job.tusUrl = validateLocation(response.location);
    // A creation response can omit the offset unless it accepted data.
    sent = offset(response, 0);
    if (sent === 0) sent = await checkOffset();
    if (sent === null) return false;
  }

  let failures = 0;
  while (sent < file.size) {
    const end = Math.min(sent + CHUNK_BYTES, file.size);
    try {
      const response = await request('PATCH', job.tusUrl, {
        'Upload-Offset': String(sent), 'Content-Type': 'application/offset+octet-stream'
      }, file.slice(sent, end), sent);
      if (!response.ok) {
        if ([400, 401, 403, 413, 415].includes(response.status)) {
          const error = new Error('영상 전송 실패 (' + response.status + ')');
          error.permanent = true;
          throw error;
        }
        throw new Error('이어 올리기 전송 실패 (' + response.status + ')');
      }
      if (offset(response) !== end) throw new Error('전송 위치가 일치하지 않아요');
      sent = end;
      failures = 0;
    } catch (error) {
      if (error.permanent || ++failures > RETRY_LIMIT) throw error;
      report('연결 확인 중 · 이어서 전송합니다', Math.round(sent / file.size * 100));
      await new Promise(resolve => setTimeout(resolve, failures * 450));
      const confirmed = await checkOffset();
      if (confirmed === null) throw new Error('전송 주소가 만료됐어요. 다시 시도해 주세요');
      if (confirmed > sent) failures = 0;
      sent = confirmed;
    }
  }
  return true;
}

export async function sendR2Video(file, options, job, transfer, onProgress, report) {
  const endpoint = new URL(options.url);
  if (!job.r2Multipart || job.r2Multipart.expires < Date.now()) {
    const creation = await fetch(endpoint, { method: 'POST' });
    if (!creation.ok) throw new Error('이어 올리기 시작 실패 (' + creation.status + ')');
    const result = await creation.json();
    if (result.complete) return;
    const url = new URL(result.url, endpoint);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || !url.searchParams.has('grant')) {
      throw new Error('이어 올리기 주소를 확인하지 못했어요');
    }
    job.r2Multipart = { url: url.href, parts: [], expires: Date.now() + 43 * 60_000 };
  }

  const { url, parts } = job.r2Multipart;
  const partSize = options.partBytes;
  for (let start = parts.length * partSize; start < file.size; start += partSize) {
    const partNumber = parts.length + 1;
    const partUrl = new URL(url);
    partUrl.searchParams.set('part', partNumber);
    const chunk = file.slice(start, start + partSize);
    const progress = (_percent, loaded) => {
      const uploaded = Math.min(file.size, start + loaded);
      onProgress?.(Math.min(99, Math.round(uploaded / file.size * 100)), uploaded, file.size);
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await transfer(partUrl.href, chunk, { 'Content-Type': 'application/offset+octet-stream' }, progress);
        if (!result.ok) {
          const error = new Error('이어 올리기 전송 실패 (' + result.status + ')');
          error.permanent = result.status >= 400 && result.status < 500;
          throw error;
        }
        const part = JSON.parse(result.text);
        if (part.partNumber !== partNumber || !part.etag) throw new Error('전송 상태를 확인하지 못했어요');
        parts.push(part);
        break;
      } catch (error) {
        if (error.permanent || attempt >= RETRY_LIMIT) throw error;
        report('연결 확인 중 · 이어서 전송합니다', Math.round(start / file.size * 100));
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 450));
      }
    }
  }

  const completion = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parts)
  });
  if (!completion.ok || !(await completion.json()).complete) {
    throw new Error('영상 전송을 마무리하지 못했어요 (' + completion.status + ')');
  }
}
