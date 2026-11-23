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
