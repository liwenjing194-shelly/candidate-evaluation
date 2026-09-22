import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Small private pilot: shared browser Basic Auth, never anonymous public candidate data. */
export function registerAccessControl(app: FastifyInstance, password: string | undefined, required: boolean) {
  if (required && (!password || password.length < 16)) throw new Error("公网部署必须设置至少16字符的 APP_ACCESS_PASSWORD。");
  if (!password) return;
  const expected = createHash("sha256").update(`reviewer:${password}`).digest();
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" && request.url === "/api/health") return;
    const header = request.headers.authorization ?? "";
    const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
    if (!timingSafeEqual(expected, createHash("sha256").update(decoded).digest())) {
      return reply.header("WWW-Authenticate", 'Basic realm="Candidate Review", charset="UTF-8"').code(401).send({ error: "请使用访问账号登录" });
    }
    const origin = request.headers.origin;
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && origin) {
      let originHost = "";
      try { originHost = new URL(origin).host; } catch { /* invalid */ }
      if (originHost !== request.headers.host) return reply.code(403).send({ error: "不允许跨站修改" });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("X-Frame-Options", "DENY");
    return payload;
  });
}
