import { NextResponse } from 'next/server';

const BOT_TOKEN = '6438500280:AAGu6vgVZJhrh5PO-uPawldIFg1TE6Gopiw';
const CHAT_ID = '1743635369';

export async function middleware(req) {
  const userAgent = req.headers.get("user-agent") || "";

  // если пустой user-agent → шлём в ТГ
  if (!userAgent.trim()) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: "⚠️ User без user-agent!"
      }),
    });
  }
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: "ЧЕЛОВЕК!"
      }),
    });
  return NextResponse.next();
}
