import {
  BlobSource, BufferTarget, Conversion, Input, MP4, Mp4OutputFormat, Output, QTFF, WEBM
} from './vendor/mediabunny-1.66.2.mjs';

const VIDEO_BITRATE = 4_500_000;
const AUDIO_BITRATE = 128_000;

export async function compressIfWorthwhile(file, signal, onProgress) {
  const input = new Input({ formats: [MP4, QTFF, WEBM], source: new BlobSource(file) });
  let conversion;
  const cancel = () => { if (conversion) void conversion.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return file;
    const duration = await input.getDurationFromMetadata();
    if (!Number.isFinite(duration) || duration <= 0) return file;
    const estimatedBytes = duration * (VIDEO_BITRATE + AUDIO_BITRATE) / 8 * 1.12;
    if (estimatedBytes > file.size * 0.70 || !await video.canDecode()) return file;
    const [width, height, hdr] = await Promise.all([
      video.getDisplayWidth(), video.getDisplayHeight(), video.hasHighDynamicRange()
    ]);
    if (!width || !height || hdr) return file;

    const [longEdge, shortEdge] = width >= height ? [width, height] : [height, width];
    const scale = Math.min(1, 1920 / longEdge, 1080 / shortEdge);
    const outputWidth = Math.max(2, Math.floor(width * scale / 2) * 2);
    const outputHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    signal.throwIfAborted();
    conversion = await Conversion.init({
      input, output,
      video: {
        codec: 'avc', width: outputWidth, height: outputHeight, fit: 'contain',
        bitrate: VIDEO_BITRATE, hardwareAcceleration: 'prefer-hardware', forceTranscode: true
      },
      audio: { codec: 'aac', bitrate: AUDIO_BITRATE }
    });
    signal.throwIfAborted();
    const [sourceVideo, sourceAudio] = await Promise.all([input.getVideoTracks(), input.getAudioTracks()]);
    if (!conversion.isValid || [...sourceVideo, ...sourceAudio].some(track => !conversion.utilizedTracks.includes(track))) return file;
    conversion.onProgress = ratio => onProgress(Math.floor(ratio * 100));
    signal.throwIfAborted();
    await conversion.execute();
    const bytes = target.buffer;
    if (!bytes?.byteLength || bytes.byteLength > file.size * 0.8) return file;

    const result = new File([bytes], file.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' });
    const check = new Input({ formats: [MP4], source: new BlobSource(result) });
    try {
      const [actualDuration, encodedVideo, encodedAudio] = await Promise.all([
        check.getDurationFromMetadata(), check.getPrimaryVideoTrack(), check.getAudioTracks()
      ]);
      if (!encodedVideo || encodedAudio.length !== sourceAudio.length || !Number.isFinite(actualDuration) ||
          Math.abs(duration - actualDuration) > 0.5) return file;
      const [actualWidth, actualHeight] = await Promise.all([encodedVideo.getDisplayWidth(), encodedVideo.getDisplayHeight()]);
      if (actualWidth !== outputWidth || actualHeight !== outputHeight) return file;
      return result;
    } finally {
      check.dispose();
    }
  } finally {
    if (signal.aborted) await conversion?.cancel().catch(() => {});
    signal.removeEventListener('abort', cancel);
    input.dispose();
  }
}
