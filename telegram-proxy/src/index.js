/**
 * Cloudflare Worker — Telegram API Proxy for Chiera
 * Bypasses ISP blocking of api.telegram.org
 *
 * Usage: https://<worker>.workers.dev/bot<TOKEN>/<method>
 * Same API as https://api.telegram.org/bot<TOKEN>/<method>
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "chiera-telegram-proxy" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!url.pathname.startsWith("/bot")) {
      return new Response(JSON.stringify({ error: "Use /bot<TOKEN>/<method>" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const telegramUrl = `https://api.telegram.org${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.delete("host");

    const telegramResponse = await fetch(telegramUrl, {
      method: request.method,
      headers,
      body: request.method !== "GET" ? await request.text() : undefined,
    });

    const responseHeaders = new Headers(telegramResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(telegramResponse.body, {
      status: telegramResponse.status,
      headers: responseHeaders,
    });
  },
};
