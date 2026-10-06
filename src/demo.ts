import { randomUUID } from "node:crypto";
import type { RouteService } from "./service.ts";

type Print = (obj: unknown) => void;

/** 内置演示：默认路由 + /8 + /16 + /24 drop，以及禁用 /16 后的回退 */
export async function runDemo(service: RouteService, print: Print): Promise<void> {
  const tableId = `demo-${randomUUID().slice(0, 8)}`;
  service.createTable(tableId);
  let version = 0;
  const commit = (newVersion: number): void => {
    version = newVersion;
  };

  commit(service.bulkImport(tableId, [
    { id: "default", cidr: "0.0.0.0/0", action: "forward", nextHop: "192.0.2.1", metric: 100 },
    { id: "rfc10", cidr: "10.0.0.0/8", action: "forward", nextHop: "192.0.2.10", metric: 50 },
    { id: "rfc10-1", cidr: "10.1.0.0/16", action: "forward", nextHop: "192.0.2.11", metric: 20 },
    { id: "block-10-1-2", cidr: "10.1.2.0/24", action: "drop", metric: 0 },
  ], version).version);

  print({
    step: "已导入 4 条路由（0.0.0.0/0、10.0.0.0/8、10.1.0.0/16、10.1.2.0/24 drop）",
    tableId,
    version,
  });

  print({ step: "查询 10.1.2.9（应被 /24 drop，不回退 /16）", ...service.query(tableId, "10.1.2.9") });
  print({ step: "查询 10.1.3.9（应走 /16）", ...service.query(tableId, "10.1.3.9") });
  print({ step: "查询 10.255.255.255（/8 首末地址不排除，走 /8）", ...service.query(tableId, "10.255.255.255") });
  print({ step: "查询 8.8.8.8（仅命中 /0 兜底）", ...service.query(tableId, "8.8.8.8") });

  commit(service.setEnabled(tableId, "rfc10-1", false, version));
  print({ step: "禁用 10.1.0.0/16 后查询 10.1.3.9（应回退 /8）", ...service.query(tableId, "10.1.3.9") });

  const historical = service.query(tableId, "10.1.3.9", version - 1);
  print({
    step: `显式按历史版本 ${version - 1} 查询（仍走 /16，证明历史报告不被最新树改写）`,
    ...historical,
  });
}
