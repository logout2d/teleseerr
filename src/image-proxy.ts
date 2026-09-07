import type { IncomingMessage, ServerResponse } from "http";
import { config } from "./config.js";
import { log } from "./logger.js";

const IMAGE_ROUTE =
  /^\/image\/(w92|w154|w185|w342|w500|w780|original)(\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/i;

export async function handleTmdbImageProxy(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (!path.startsWith("/image/")) return false;

  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end();
    return true;
  }

  const match = IMAGE_ROUTE.exec(path);
  if (!match) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid image path");
    return true;
  }

  const size = match[1];
  const imagePath = match[2];
  if (!size || !imagePath) {
    res.writeHead(400);
    res.end();
    return true;
  }

  const base = config.TMDB_IMAGE_BASE.replace(/\/$/, "");
  const target = `${base}/${size}${imagePath}`;

  try {
    const upstream = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Teleseerr/1.0" },
    });

    if (!upstream.ok) {
      const status = upstream.status === 404 ? 404 : 502;
      if (status === 502) {
        log.warn({ upstreamStatus: upstream.status, size }, "TMDB image proxy upstream error");
      }
      res.writeHead(status);
      res.end();
      return true;
    }

    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0];
    if (!contentType?.startsWith("image/")) {
      log.warn({ contentType, size }, "TMDB image proxy rejected non-image response");
      res.writeHead(502);
      res.end();
      return true;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": String(body.length),
      "Cache-Control": "public, max-age=604800, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch (e) {
    log.warn({ err: e, size }, "TMDB image proxy request failed");
    res.writeHead(502);
    res.end();
  }

  return true;
}
