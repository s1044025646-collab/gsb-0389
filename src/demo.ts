import { join } from "node:path";
import { createAppContext } from "./app";

const path = process.env.LPM_DB_PATH ?? join(process.cwd(), "data", "demo.sqlite");
const { database, service } = createAppContext(path);
const table = service.createTable({ name: "演示表" });
let version = 0;
const expectVersion = (expectedVersion: number) => ({ expectedVersion });

const importResult = service.importRoutes(table.table_id, [
  { routeId: 1, cidr: "0.0.0.0/0", metric: 100, enabled: true, action: "forward", nextHop: "192.0.2.1" },
  { routeId: 2, cidr: "10.0.0.0/8", metric: 20, enabled: true, action: "forward", nextHop: "192.0.2.10" },
  { routeId: 3, cidr: "10.1.0.0/16", metric: 10, enabled: true, action: "forward", nextHop: "192.0.2.16" },
  { routeId: 4, cidr: "10.1.2.0/24", metric: 1, enabled: true, action: "drop" }
], expectVersion(version));
version = importResult.version;

const first = service.lookup(table.table_id, { destination: "10.1.2.9", version });
const second = service.lookup(table.table_id, { destination: "10.1.3.9", version });
const disabled = service.setEnabled(table.table_id, 3, false, expectVersion(version));
version = disabled.version;
const fallback = service.lookup(table.table_id, { destination: "10.1.3.9", version });

console.log(JSON.stringify({
  tableId: table.table_id,
   beforeDisable: {
    "10.1.2.9": { outcome: first.outcome, prefix: first.matchedPrefix, routeId: first.selectedRouteId },
    "10.1.3.9": { outcome: second.outcome, prefix: second.matchedPrefix, routeId: second.selectedRouteId }
  },
  afterDisable10_1_0_0_16: {
    version,
    "10.1.3.9": { outcome: fallback.outcome, prefix: fallback.matchedPrefix, routeId: fallback.selectedRouteId }
  }
}, null, 2));

database.close();
