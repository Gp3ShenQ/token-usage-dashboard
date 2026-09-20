import { HandoffService, type HandoffOptions } from "./monitor/handoff.js";
import { SessionMonitorService } from "./monitor/service.js";
import { UsageDatabase } from "./db/database.js";
import { UsageScanner } from "./scanner/scanner.js";
import { createApiServer } from "./api/server.js";

export async function bootstrapServer(handoffOptions?: Omit<HandoffOptions, "getSession">) {
  const db = new UsageDatabase();
  const scanner = new UsageScanner(db);
  const monitor = new SessionMonitorService();
  await monitor.start();
  const handoff = handoffOptions ? new HandoffService({ ...handoffOptions, getSession: (source, id) => monitor.get(source, id) }) : null;
  const api = await createApiServer(db, scanner, monitor, handoff && handoffOptions ? { service: handoff, token: handoffOptions.token } : undefined);

  await api.listen();
  void scanner.scan();

  return {
    db,
    scanner,
    monitor,
    api,
    async close() {
      await api.close();
      await handoff?.close();
      await monitor.close();
      db.close();
    },
  };
}
