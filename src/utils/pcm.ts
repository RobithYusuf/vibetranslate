// Convert a recorded Blob (WebM/Opus from MediaRecorder) into 16 kHz mono PCM16,
// base64-encoded — the input format of the local sherpa-onnx engine (transcribe_local).
// Decoding + resampling happen with WebAudio, so no native codecs are involved.
export async function blobToPcm16kBase64(blob: Blob): Promise<string> {
  const TARGET_RATE = 16000;
  const buf = await blob.arrayBuffer();
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(buf);
  } finally {
    void probe.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const f32 = rendered.getChannelData(0);
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  const CHUNK = 0x8000; // keep String.fromCharCode within arg limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
