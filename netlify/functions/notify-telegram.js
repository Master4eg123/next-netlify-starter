exports.handler = async function(event, context) {
try {
const body = event.body ? JSON.parse(event.body) : {};
const text = body.text || (typeof body === 'string' ? body : '');
const mainDomain = body.mainDomain || 'unknown-domain';


const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;
const TELEGRAM_TIMEOUT_MS = 2700;


if (!BOT_TOKEN || !CHAT_ID) {
console.warn('notify-telegram: TG_BOT_TOKEN or TG_CHAT_ID not set');
return { statusCode: 200, body: 'no-secrets' };
}


const finalText = `🌐 main: ${mainDomain}\n${text}`;


// Node runtime in Netlify functions supports AbortController in modern images; otherwise this will still work without signal.
const controller = new AbortController();
const id = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);


await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: CHAT_ID, text: finalText }),
signal: controller.signal,
});


clearTimeout(id);
return { statusCode: 200, body: 'ok' };
} catch (err) {
console.warn('notify-telegram failed:', err?.message || err);
return { statusCode: 500, body: String(err) };
}
};
