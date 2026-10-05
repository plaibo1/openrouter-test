# STT Playground через OpenRouter

Загружаешь аудио/видео → получаешь транскрипт с таймингами от выбранной STT-модели OpenRouter
(по умолчанию `openai/whisper-large-v3-turbo`) и, по желанию, краткое суммари.

## Локально

Нужны Node 20.6+ и `ffmpeg` (`brew install ffmpeg`).

```bash
cp .env.example .env   # вписать OPENROUTER_API_KEY
npm install
npm start              # http://localhost:3000
```

## Docker

Локально через compose (переменные берутся из `.env`):

```bash
cp .env.example .env   # вписать OPENROUTER_API_KEY
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build   # http://localhost:3000
```

Другой внешний порт: `HOST_PORT=8080 docker compose -f docker-compose.yml -f docker-compose.local.yml up -d`.

### Dokploy

Тип приложения Docker Compose, файл `docker-compose.yml` (порт наружу не публикуется, это задача Traefik).
1. Environment: `OPENROUTER_API_KEY=...` (и при желании `SUMMARY_MODEL=...`).
2. Domains: сервис `app`, Container Port `3000`.
3. Deploy.

Или вручную:

```bash
docker build -t openrouter-stt .
docker run -d -p 3000:3000 -e OPENROUTER_API_KEY=sk-or-v1-... openrouter-stt
```

Переменные окружения:

| Переменная | Обязательна | Описание |
|---|---|---|
| `OPENROUTER_API_KEY` | да | ключ OpenRouter |
| `SUMMARY_MODEL` | нет | модель суммари по умолчанию; не задана — суммари выключено (включается в UI) |
| `PORT` | нет | порт внутри контейнера, по умолчанию 3000 |

Можно и `docker run --env-file .env ...`. Если в `.env` задан `PORT`, сервер в контейнере
слушает его — тогда маппинг должен быть `-p <внешний>:<PORT>`. Платформы вроде Render/Railway/Fly
сами передают `PORT`, сервер его подхватывает.

При деплое за прокси (nginx и т.п.) учти: загрузка до 1 ГБ (`client_max_body_size`),
а обработка длинного файла может идти минуты (`proxy_read_timeout`).

## Как устроено

- `server.js`: Express. ffmpeg переводит файл в WAV 16 kHz и режет на mp3-куски по 10 минут
  (у OpenRouter таймаут 60 с на провайдера). Куски параллельно уходят в `/api/v1/audio/transcriptions`
  с `response_format: verbose_json`; сегменты берутся как их вернула модель, только сдвигаются на начало куска.
  Модели без `verbose_json` автоматически запрашиваются без таймингов.
- `public/index.html`: Tailwind из CDN, выбор моделей, плеер, клик по сегменту перематывает, экспорт .srt/.txt.
