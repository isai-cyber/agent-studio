// Voz con ElevenLabs: texto→voz (TTS) y voz→texto (STT, modelo Scribe).
const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY ?? '';
const DEFAULT_VOICE = process.env.ELEVENLABS_DEFAULT_VOICE ?? '21m00Tcm4TlvDq8ikWAM';
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_multilingual_v2';
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v1';

export function voiceConfigured(): boolean {
  return Boolean(KEY);
}

function requireKey(): void {
  if (!KEY) throw new Error('Falta ELEVENLABS_API_KEY en .env');
}

export async function textToSpeech(text: string, voiceId?: string, modelId?: string): Promise<Buffer> {
  requireKey();
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId || DEFAULT_VOICE)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: text.slice(0, 5000), model_id: modelId || TTS_MODEL }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function speechToText(audio: Buffer, mime: string, language?: string): Promise<string> {
  requireKey();
  const form = new FormData();
  form.append('model_id', STT_MODEL);
  if (language) form.append('language_code', language);
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`);
  const res = await fetch(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': KEY }, body: form });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { text?: string };
  return data.text ?? '';
}

export async function listVoices(): Promise<{ voice_id: string; name: string; labels?: Record<string, string> }[]> {
  requireKey();
  const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': KEY } });
  if (!res.ok) throw new Error(`ElevenLabs voices ${res.status}`);
  const data = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  return data.voices.map((v) => ({ voice_id: v.voice_id, name: v.name, labels: v.labels }));
}
