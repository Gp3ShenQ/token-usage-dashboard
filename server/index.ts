import { SessionMonitorService } from "./monitor/service.js";
import { UsageDatabase } from "./db/database.js";
import { UsageScanner } from "./scanner/scanner.js";
import { createApiServer } from "./api/server.js";

export async function bootstrapServer() {
  const db = new UsageDatabase();
  const scanner = new UsageScanner(db);
  const monitor = new SessionMonitorService();
  await monitor.start();
  const api = await createApiServer(db, scanner, monitor);

  await api.listen();
  void scanner.scan();

  return {
    db,
    scanner,
    monitor,
    api,
    async close() {
      await api.close();
      await monitor.close();
      db.close();
    },
  };
}
