import type { FastifyInstance } from "fastify";
import type { SessionMonitorService } from "./service.js";
import type { AgentSource } from "./state.js";

export function registerMonitorRoutes(app: FastifyInstance, monitor: SessionMonitorService) {
  type Query = { source?: string; session?: string };
  const isValid = (query: Query): query is { source: AgentSource; session: string } =>
    (query.source === "claude" || query.source === "codex") && typeof query.session === "string" &&
    /^[a-zA-Z0-9_-]{8,128}$/.test(query.session);
  const connections = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of connections) close(); });

  app.get<{ Querystring: Query }>("/api/monitor", async (request, reply) => {
    if (!isValid(request.query)) return reply.code(400).send({ ok: false, error: "無效的 session。" });
    return { ok: true, data: await monitor.get(request.query.source, request.query.session) };
  });

  app.get<{ Querystring: Query }>("/api/monitor/stream", async (request, reply) => {
    const query = request.query;
    if (!isValid(query)) return reply.code(400).send({ ok: false, error: "無效的 session。" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    let closed = false;
    let sending = false;
    let pending = false;
    const send = async () => {
      if (closed) return;
      if (sending) { pending = true; return; }
      sending = true;
      try {
        do {
          pending = false;
          const snapshot = await monitor.get(query.source, query.session);
          if (!closed) {
            if (reply.raw.writableLength > 64 * 1024) { close(); break; }
            reply.raw.write("data: " + JSON.stringify(snapshot) + "\n\n");
          }
        } while (pending && !closed);
      } catch { close(); }
      finally { sending = false; }
    };
    const unsubscribe = monitor.subscribe(() => { void send(); });
    const heartbeat = setInterval(() => { void send(); }, 15_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      connections.delete(close);
      reply.raw.end();
    };
    connections.add(close);
    reply.raw.on("close", close);
    await send();
  });
}
