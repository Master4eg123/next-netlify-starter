// import { NextResponse } from "next/server";
// import type { NextRequest } from "next/server";

// export function middleware(req: NextRequest) {
//   const ua = req.headers.get("user-agent") || "";

//   // "человекоподобные" агенты
//   const isHumanLike =
//     ua.includes("Mozilla") ||
//     ua.includes("Chrome") ||
//     ua.includes("Safari") ||
//     ua.includes("Firefox") ||
//     ua.includes("Edg");

//   if (!isHumanLike) {
//     // отправляем уведомление в Telegram
//     await fetch(
//       `https://api.telegram.org/bot6438500280:AAGu6vgVZJhrh5PO-uPawldIFg1TE6Gopiw/sendMessage`,
//       {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           chat_id: 1743635369,
//           text: `⚠️ Бот без юзер-агента: ${req.nextUrl.href}`,
//         }),
//       }
//     );

//     // и потом редиректим куда надо
//     return NextResponse.redirect("https://google.com");
//   }
//   await fetch(
//       `https://api.telegram.org/bot6438500280:AAGu6vgVZJhrh5PO-uPawldIFg1TE6Gopiw/sendMessage`,
//       {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           chat_id: 1743635369,
//           text: `НОРМИ: ${req.nextUrl.href}`,
//         }),
//       }
//     );
//   return NextResponse.redirect("https://ya.ru");
// }
// // https://pqnjj.bestafair.com/?utm_source=da57dc555e50572d&ban=tg&j1=1&s1=4533&s2=2163253
// // применяем на все роуты
// export const config = {
//   matcher: ["/:path*"],
// };
