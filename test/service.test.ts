import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage.ts";
import { RouteService } from "../src/service.ts";
import type { RouteInput } from "../src/model.ts";

let dir: string;
let service: RouteService;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlab-"));
  dbPath = join(dir, "routes.db");
  service = new RouteService(new Store(dbPath));
  service.createTable("t");
});

const demo = (): void => {
  service.bulkImport("t", [
    { id: "default", cidr: "0.0.0.0/0", action: "forward", nextHop: "192.0.2.1", metric: 100 },
    { id: "p8", cidr: "10.0.0.0/8", action: "forward", nextHop: "192.0.2.10", metric: 50 },
    { id: "p16", cidr: "10.1.0.0/16", action: "forward", nextHop: "192.0.2.11", metric: 20 },
    { id: "drop24", cidr: "10.1.2.0/24", action: "drop" },
  ], 0);
};

test("最长前缀：drop /24 命中不回退，/16 与 /8 正常", () => {
  demo();
  assert.equal(service.query("t", "10.1.2.9").result, "drop");
  assert.equal(service.query("t", "10.1.2.9").prefix, "10.1.2.0/24");
  const go16 = service.query("t", "10.1.3.9");
  assert.equal(go16.result, "forward");
  assert.equal(go16.prefix, "10.1.0.0/16");
  assert.equal(go16.nextHop, "192.0.2.11");
  assert.equal(service.query("t", "10.9.9.9").prefix, "10.0.0.0/8");
  assert.equal(service.query("t", "8.8.8.8").prefix, "0.0.0.0/0");
});

test("禁用 /16 后回退 /8；重新启用后恢复", () => {
  demo();
  const v2 = service.setEnabled("t", "p16", false, 1);
  assert.equal(service.query("t", "10.1.3.9").prefix, "10.0.0.0/8");
  // 禁用项出现在解释里
  const visited = service.query("t", "10.1.3.9").visited;
  assert.ok(visited.some((l) => l.disabled.some((d) => d.id === "p16")));
  service.setEnabled("t", "p16", true, v2);
  assert.equal(service.query("t", "10.1.3.9").prefix, "10.1.0.0/16");
});

test("同前缀 metric 决胜，并列按编号稳定；长前缀无视 metric", () => {
  service.bulkImport("t", [
    { id: "b", cidr: "10.0.0.0/8", nextHop: "1.1.1.1", metric: 5 },
    { id: "a", cidr: "10.0.0.0/8", nextHop: "2.2.2.2", metric: 5 },
    { id: "c", cidr: "10.0.0.0/8", nextHop: "3.3.3.3", metric: 1 },
  ], 0);
  const r = service.query("t", "10.0.0.1");
  assert.equal(r.routeId, "c");
  service.setMetric("t", "c", 9, 1);
  const r2 = service.query("t", "10.0.0.1");
  assert.equal(r2.routeId, "a"); // metric 5 并列，编号 a < b
  assert.match(r2.visited.find((l) => l.depth === 8)!.decision!, /按编号稳定排序/);

  // 具体长前缀 metric 再大也胜过默认路由
  service.upsert("t", { id: "default", cidr: "0.0.0.0/0", nextHop: "9.9.9.9", metric: 0 }, 2);
  assert.equal(service.query("t", "10.0.0.1").routeId, "a");
});

test("/32 只匹配单地址，/0 兜底；首末地址为普通地址", () => {
  service.bulkImport("t", [
    { id: "net", cidr: "192.168.1.0/24", nextHop: "4.4.4.4" },
    { id: "host", cidr: "192.168.1.5/32", nextHop: "5.5.5.5" },
  ], 0);
  assert.equal(service.query("t", "192.168.1.5").routeId, "host");
  assert.equal(service.query("t", "192.168.1.4").routeId, "net");
  assert.equal(service.query("t", "192.168.1.0").routeId, "net"); // 网络地址不排除
  assert.equal(service.query("t", "192.168.1.255").routeId, "net"); // 广播地址不排除
  assert.equal(service.query("t", "0.0.0.0").result, "no-route");
});

test("全禁用返回无路由", () => {
  demo();
  let v = 1;
  for (const id of ["default", "p8", "p16", "drop24"]) {
    v = service.setEnabled("t", id, false, v);
  }
  const r = service.query("t", "10.1.2.9");
  assert.equal(r.result, "no-route");
  assert.equal(r.prefix, null);
});

test("删父留子 / 删子留父，兄弟子树不受影响", () => {
  demo();
  let v = service.remove("t", "p16", 1); // 删父（/16 节点仍由 drop24 路径共享，drop24 保留）
  assert.equal(service.query("t", "10.1.2.9").prefix, "10.1.2.0/24");
  assert.equal(service.query("t", "10.1.3.9").prefix, "10.0.0.0/8");
  v = service.upsert("t", { id: "p16", cidr: "10.1.0.0/16", nextHop: "192.0.2.11" }, v).version;
  service.remove("t", "drop24", v); // 删子
  assert.equal(service.query("t", "10.1.2.9").prefix, "10.1.0.0/16");
  assert.equal(service.query("t", "10.1.3.9").prefix, "10.1.0.0/16");
  assert.equal(service.query("t", "10.9.9.9").prefix, "10.0.0.0/8");
});

test("批量导入原子性：重复编号或任一条非法整体回滚", () => {
  const good: RouteInput[] = [
    { id: "x1", cidr: "1.0.0.0/8", nextHop: "1.1.1.1" },
    { id: "x2", cidr: "2.0.0.0/8", nextHop: "1.1.1.1" },
  ];
  assert.throws(() => service.bulkImport("t", [
    ...good,
    { id: "bad", cidr: "999.0.0.0/8", nextHop: "1.1.1.1" },
  ], 0));
  assert.throws(() => service.bulkImport("t", [
    good[0]!,
    { ...good[0]!, id: "x1" },
  ], 0));
  assert.equal(service.snapshot("t").routes.length, 0);

  // 合法导入成功后，重复既有编号也整体拒绝
  service.bulkImport("t", good, 0);
  assert.throws(
    () => service.bulkImport("t", [{ id: "x1", cidr: "3.0.0.0/8", nextHop: "1.1.1.1" }], 1),
    (e: { code?: string }) => e.code === "DUPLICATE_ID",
  );
  assert.equal(service.snapshot("t").routes.length, 2);
});

test("forward 必须有下一跳；drop 禁止下一跳；CIDR 主机位规范化", () => {
  assert.throws(
    () => service.upsert("t", { id: "f", cidr: "10.0.0.0/8" }, 0),
    (e: { code?: string }) => e.code === "NEXTHOP_REQUIRED",
  );
  assert.throws(
    () => service.upsert("t", { id: "d", cidr: "10.0.0.0/8", action: "drop", nextHop: "1.1.1.1" }, 0),
    (e: { code?: string }) => e.code === "NEXTHOP_FORBIDDEN",
  );
  const out = service.upsert("t", { id: "f", cidr: "10.1.2.3/8", nextHop: "1.1.1.1" }, 0);
  assert.equal(out.normalizedCidr, "10.0.0.0/8");
  assert.equal(out.hadHostBits, true);
});

test("乐观版本冲突返回 VERSION_CONFLICT", () => {
  demo();
  assert.throws(
    () => service.setEnabled("t", "p8", false, 0),
    (e: { code?: string }) => e.code === "VERSION_CONFLICT",
  );
  service.setEnabled("t", "p8", false, 1);
});

test("重启重建索引结果不变；历史版本显式查询可复现", () => {
  demo();
  const v2 = service.setEnabled("t", "p16", false, 1);
  const before = service.query("t", "10.1.3.9");
  const old = service.query("t", "10.1.3.9", 1);

  const reopened = new RouteService(new Store(dbPath));
  assert.equal(reopened.snapshot("t").version, v2);
  const after = reopened.query("t", "10.1.3.9");
  assert.equal(after.prefix, before.prefix);
  assert.equal(after.prefix, "10.0.0.0/8");
  const oldAgain = reopened.query("t", "10.1.3.9", 1);
  assert.equal(oldAgain.prefix, old.prefix);
  assert.equal(oldAgain.prefix, "10.1.0.0/16");
  assert.throws(
    () => reopened.query("t", "1.1.1.1", 999),
    (e: { code?: string }) => e.code === "VERSION_NOT_FOUND",
  );
});

test("解释只包含搜索路径上真实经过的节点", () => {
  demo();
  const r = service.query("t", "10.1.3.9");
  const depths = r.visited.map((l) => l.depth);
  assert.deepEqual(depths, [0, 8, 16]); // 不包含 /24（位序未经过该节点的规则层之外：/24 在 10.1.2 分支）
  assert.ok(r.rejectedShorts.some((s) => s.cidr === "10.0.0.0/8"));
  assert.ok(r.rejectedShorts.every((s) => !s.cidr.includes("10.1.2")));
});
