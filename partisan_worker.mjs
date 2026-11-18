// STATAX Агент-Партизан — Userbot Worker (GramJS) для деплоя GitHub -> Amvera в 1 клик
// Требуется только ОДНА переменная окружения на Amvera: PARTISAN_SECRET
// Регистрация на my.telegram.org НЕ требуется: по умолчанию встроены ключи Telegram Desktop (api_id: 2040).
// Номер телефона (partisan_phone) и список чатов автоматически подтягиваются с сервера STATAX (/godmode -> AUTOPILOT).

import http from 'node:http';
import fetch from 'node-fetch';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';

const PARTISAN_API_URL =
  String(process.env.PARTISAN_API_URL || '').trim() ||
  'https://gen-lang-client-0351281927.web.app/api/agent/partisan';
const PARTISAN_SECRET = String(process.env.PARTISAN_SECRET || '').trim();

// Стандартные публичные API-ключи официального клиента Telegram Desktop (без my.telegram.org)
const DEFAULT_TG_API_ID = 2040;
const DEFAULT_TG_API_HASH = 'b18441a1ff607e10a989891a5462e627';

const apiId = Number(process.env.TG_API_ID || 0) || DEFAULT_TG_API_ID;
const apiHash = String(process.env.TG_API_HASH || '').trim() || DEFAULT_TG_API_HASH;
const FALLBACK_CHATS = ['@cryptosng_chat'];

let workerState = 'starting';
let activeChatsLabel = FALLBACK_CHATS.join(', ');
const recentByChat = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const healthPort = Number(process.env.PORT || 8080);
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'statax-partisan-worker',
        state: workerState,
        chats: activeChatsLabel,
      })
    );
  })
  .listen(healthPort, () => {
    console.log('[STATAX Partisan] Healthcheck listening on port', healthPort);
  });

async function callPartisanApi(payload) {
  const res = await fetch(PARTISAN_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PARTISAN_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `Partisan API HTTP ${res.status}`);
  }
  return data;
}

async function requestAuthViaTelegramBot(kind, hint = '', phone = '') {
  console.log(`[STATAX Partisan] Запрос "${kind}" через @statax_bot...`);
  const reqRes = await callPartisanApi({
    action: 'auth_request',
    kind,
    phone,
    hint: String(hint || ''),
  });
  if (!reqRes.telegram_notified && reqRes.notify_error) {
    console.warn('[STATAX Partisan] Уведомление в Telegram:', reqRes.notify_error);
  }
  const deadlineMs = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadlineMs) {
    await sleep(3000);
    const pollRes = await callPartisanApi({
      action: 'auth_poll',
      request_id: reqRes.request_id,
    });
    if (pollRes?.status === 'ready' && pollRes?.value) {
      console.log(`[STATAX Partisan] Ответ "${kind}" получен через @statax_bot.`);
      return String(pollRes.value);
    }
    if (pollRes?.status === 'expired') {
      throw new Error(`Истёк таймаут ожидания "${kind}" через Telegram Auth Relay`);
    }
  }
  throw new Error(`Не дождались ответа "${kind}" в течение 10 минут`);
}

async function runWorkerCycle() {
  if (!PARTISAN_SECRET) {
    workerState = 'missing_secret';
    console.error(
      '[STATAX Partisan] Задайте переменную окружения PARTISAN_SECRET на Amvera (скопируйте в /godmode -> AUTOPILOT).'
    );
    await sleep(30000);
    return;
  }

  workerState = 'syncing_config';
  let sessRes = await callPartisanApi({ action: 'session_get' });
  let savedSession = String(process.env.TG_SESSION || sessRes?.string_session || '').trim();
  let tgPhone = String(process.env.TG_PHONE || sessRes?.partisan_phone || '').trim();

  while (!savedSession && !tgPhone) {
    workerState = 'waiting_phone_in_godmode';
    console.log(
      '[STATAX Partisan] Ожидаю номер телефона: укажите partisan_phone и нажмите «Запустить авторизацию через @statax_bot» в /godmode -> AUTOPILOT.'
    );
    await sleep(8000);
    sessRes = await callPartisanApi({ action: 'session_get' });
    savedSession = String(process.env.TG_SESSION || sessRes?.string_session || '').trim();
    tgPhone = String(process.env.TG_PHONE || sessRes?.partisan_phone || '').trim();
  }

  const targetChats =
    Array.isArray(sessRes?.target_chats) && sessRes.target_chats.length > 0
      ? sessRes.target_chats
      : FALLBACK_CHATS;
  const activeAuthNonce = sessRes?.auth_nonce || null;
  activeChatsLabel = targetChats.join(', ');

  let client = new TelegramClient(new StringSession(savedSession), apiId, apiHash, {
    connectionRetries: 5,
  });

  let authorized = false;
  if (savedSession) {
    try {
      await client.connect();
      authorized = await client.checkAuthorization();
    } catch (err) {
      console.warn('[STATAX Partisan] Сохранённая сессия отклонена:', err?.message || err);
      authorized = false;
    }
    if (!authorized) {
      try {
        await client.disconnect();
      } catch {}
      await callPartisanApi({ action: 'session_clear' }).catch(() => null);
      if (!tgPhone) {
        return;
      }
      client = new TelegramClient(new StringSession(''), apiId, apiHash, {
        connectionRetries: 5,
      });
    }
  }

  if (!authorized) {
    workerState = 'authorizing_via_bot';
    console.log('[STATAX Partisan] Запуск авторизации для номера', tgPhone);
    await client.start({
      phoneNumber: async () => tgPhone,
      phoneCode: async () => await requestAuthViaTelegramBot('code', '', tgPhone),
      password: async (hint) => await requestAuthViaTelegramBot('password', hint, tgPhone),
      onError: (err) => console.error('[GramJS Auth Error]', err?.message || err),
    });

    const newSession = String(client.session.save() || '').trim();
    if (newSession.length >= 20) {
      await callPartisanApi({
        action: 'session_save',
        string_session: newSession,
        phone: tgPhone,
      });
      console.log('[STATAX Partisan] Новая StringSession сохранена в облако STATAX.');
    }
  }

  workerState = 'listening';
  console.log('[STATAX Partisan] Подключено. Мониторинг чатов:', targetChats.join(', '));

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      const text = (msg?.message || '').trim();
      if (!text || text.length < 12 || msg?.out) return;

      const chat = await event.getChat();
      const chatUsername = chat?.username ? '@' + chat.username : String(chat?.id || '');
      const chatTitle = chat?.title || chatUsername;

      const history = recentByChat.get(chatUsername) || [];
      const context = history.slice(-4).join('\n');
      history.push(text.slice(0, 220));
      recentByChat.set(chatUsername, history.slice(-6));

      const data = await callPartisanApi({
        action: 'analyze',
        chat_id: chatUsername,
        chat_title: chatTitle,
        message_id: String(msg.id || ''),
        sender_id: String(msg.senderId || ''),
        text,
        context,
      });

      if (data?.should_reply && data?.reply) {
        const delayMs = 8000 + Math.floor(Math.random() * 12000);
        await sleep(delayMs);
        await msg.reply({ message: data.reply, linkPreview: false });
        console.log(
          '[Replied]',
          chatUsername,
          data.intent,
          `(${data.hourly_used}/${data.hourly_limit})`
        );
      }
    } catch (err) {
      console.error('[Partisan handler error]', err?.message || err);
    }
  }, new NewMessage({ chats: targetChats }));

  // Периодически проверяем команды из /godmode (переавторизация нового номера или изменение списка чатов)
  const baseChatsSignature = [...targetChats].sort().join(',');
  while (true) {
    await sleep(25000);
    try {
      const latest = await callPartisanApi({ action: 'session_get' });
      const latestNonce = latest?.auth_nonce || null;
      const latestChatsSignature = Array.isArray(latest?.target_chats)
        ? [...latest.target_chats].sort().join(',')
        : baseChatsSignature;

      if (latest?.status === 'auth_requested' && latestNonce && latestNonce !== activeAuthNonce) {
        console.log('[STATAX Partisan] Получен запрос переавторизации из /godmode...');
        break;
      }
      if (latestChatsSignature && latestChatsSignature !== baseChatsSignature) {
        console.log('[STATAX Partisan] Обновлён список целевых чатов в /godmode, переподключаюсь...');
        break;
      }
    } catch (syncErr) {
      console.warn('[STATAX Partisan] Ошибка синхронизации конфига:', syncErr?.message || syncErr);
    }
  }

  try {
    await client.disconnect();
  } catch {}
}

async function bootstrap() {
  while (true) {
    try {
      await runWorkerCycle();
    } catch (err) {
      workerState = 'retrying';
      console.error('[STATAX Partisan Error]', err?.message || err);
      // Пауза 60 секунд защищает аккаунт от FloodWait при ошибке входа или таймауте кода
      await sleep(60000);
    }
  }
}

bootstrap();
