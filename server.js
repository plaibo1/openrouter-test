import express from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// docker --env-file, в отличие от node --env-file, не снимает кавычки: KEY="..." приходит вместе с ними
const env = (name) => process.env[name]?.trim().replace(/^(["'])(.*)\1$/, '$2') || undefined;

const API_KEY = env('OPENROUTER_API_KEY');
const DEFAULT_STT_MODEL = 'openai/whisper-large-v3-turbo';
// По умолчанию суммари выключено; SUMMARY_MODEL в env включает его для новых пользователей
const DEFAULT_SUMMARY_MODEL = env('SUMMARY_MODEL') || '';
const SUMMARY_MODELS = [
  ...new Set(
    [DEFAULT_SUMMARY_MODEL, 'google/gemini-3.5-flash', 'openai/gpt-5.4-mini', 'anthropic/claude-haiku-4.5'].filter(Boolean),
  ),
];
const PORT = env('PORT') || 3000;
// OpenRouter режет запрос к провайдеру по таймауту 60с, поэтому длинное аудио режем на куски
const CHUNK_SECONDS = 600;
const CONCURRENCY = 3;

if (!API_KEY) {
  console.error('OPENROUTER_API_KEY не задан. Скопируй .env.example в .env и впиши ключ.');
  process.exit(1);
}

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), 'whisper-uploads'), limits: { fileSize: 1024 * 1024 * 1024 } });

app.use(express.static(path.join(import.meta.dirname, 'public')));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.slice(-500)}`))));
  });
}

// Любое аудио/видео -> mono 16kHz WAV, затем режем на mp3-куски по CHUNK_SECONDS.
// Режем из WAV поштучно через -ss: так обрезка точная до сэмпла и смещение куска ровно i * CHUNK_SECONDS.
// (segment muxer сразу в mp3 даёт кускам ненулевой start_time, и тайминги уезжают на склейках)
async function toMp3Chunks(inputPath, workDir) {
  const wav = path.join(workDir, 'full.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', wav]);
  const duration = (await fs.stat(wav)).size / (16000 * 2); // 16-bit mono, заголовок пренебрежимо мал
  const chunks = [];
  for (let offset = 0, i = 0; offset < duration; offset += CHUNK_SECONDS, i++) {
    const file = path.join(workDir, `chunk_${i}.mp3`);
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-ss', String(offset), '-t', String(CHUNK_SECONDS), '-i', wav,
      '-c:a', 'libmp3lame', '-b:a', '48k', file,
    ]);
    chunks.push({ file, offset, duration: Math.min(CHUNK_SECONDS, duration - offset) });
  }
  return chunks;
}

async function openrouter(endpoint, body) {
  const res = await fetch(`https://openrouter.ai/api/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`OpenRouter ${endpoint} ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function transcribeChunk(chunk, { model, language }) {
  const data = (await fs.readFile(chunk.file)).toString('base64');
  const body = {
    model,
    input_audio: { data, format: 'mp3' },
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
    ...(language ? { language } : {}),
  };
  try {
    return await openrouter('audio/transcriptions', body);
  } catch (e) {
    // Часть моделей не умеет verbose_json (400) — тогда берём просто текст без таймингов
    if (e.status === 400) {
      console.warn(`${model}: verbose_json отклонён, повторяем без таймингов`);
      const { response_format, timestamp_granularities, ...plain } = body;
      return { ...(await openrouter('audio/transcriptions', plain)), noTimestamps: true };
    }
    if (e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
    console.warn('retry chunk', chunk.offset, e.message);
    return openrouter('audio/transcriptions', body);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function summarize(text, model) {
  const res = await openrouter('chat/completions', {
    model,
    messages: [
      {
        role: 'system',
        content:
          'Ты делаешь краткое саммари транскрипта. Пиши на языке транскрипта. Формат: 1-2 предложения сути, затем 3-7 ключевых пунктов списком (markdown "- "). Без вступлений.',
      },
      { role: 'user', content: text },
    ],
  });
  return { text: res.choices?.[0]?.message?.content?.trim() || '', cost: res.usage?.cost ?? null };
}

let sttModelsCache = null;
app.get('/api/models', async (req, res) => {
  try {
    if (!sttModelsCache) {
      const r = await fetch('https://openrouter.ai/api/v1/models?output_modalities=transcription');
      if (!r.ok) throw new Error(`OpenRouter models ${r.status}`);
      sttModelsCache = (await r.json()).data
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    res.json({
      stt: sttModelsCache,
      summary: SUMMARY_MODELS,
      defaults: { stt: DEFAULT_STT_MODEL, summary: DEFAULT_SUMMARY_MODEL },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
  const sttModel = req.body.sttModel || DEFAULT_STT_MODEL;
  // пустая строка = суммари не нужно
  const summaryModel = req.body.summaryModel ?? DEFAULT_SUMMARY_MODEL;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-'));
  const t0 = Date.now();
  try {
    const chunks = await toMp3Chunks(req.file.path, workDir);
    if (!chunks.length) throw new Error('В файле не найдена аудиодорожка');
    const tConvert = Date.now();

    const results = await mapLimit(chunks, CONCURRENCY, (c) => transcribeChunk(c, { model: sttModel, language: req.body.language }));
    const tStt = Date.now();

    const segments = results.flatMap((r, i) =>
      // Сегменты как их вернула модель; только сдвигаем на начало куска
      (r.segments || []).map((s) => ({
        start: s.start + chunks[i].offset,
        end: s.end + chunks[i].offset,
        text: s.text.trim(),
      })),
    );
    const text = results.map((r) => r.text?.trim()).filter(Boolean).join(' ');
    const sttCost = results.reduce((sum, r) => sum + (r.usage?.cost || 0), 0);

    let summary = null;
    let summaryError = null;
    if (text && summaryModel) {
      try {
        summary = await summarize(text, summaryModel);
      } catch (e) {
        summaryError = e.message;
      }
    }

    res.json({
      text,
      language: results[0]?.language || null,
      duration: chunks.reduce((s, c) => s + c.duration, 0),
      segments,
      hasTimestamps: !results.some((r) => r.noTimestamps),
      summary: summary?.text || null,
      summaryError,
      models: { stt: sttModel, summary: summaryModel || null },
      cost: { stt: sttCost, summary: summary?.cost ?? null },
      timings: {
        convertMs: tConvert - t0,
        sttMs: tStt - tConvert,
        summaryMs: Date.now() - tStt,
        chunks: chunks.length,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    fs.rm(workDir, { recursive: true, force: true });
    fs.rm(req.file.path, { force: true });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
