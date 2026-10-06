import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { Store } from "../src/storage.ts";
import { RouteService } from "../src/service.ts";
import { linearScan } from "../src/scan.ts";
import { formatIPv4, parseIPv4Strict } from "../src/ip.ts";
import type { RouteInput } from "../src/model.ts";

/**
 * 随机小路由表差分测试：
 * trie 查询（正式实现）逐地址对比独立线性扫描基准；
 * 在每次增/删/启停/改 metric 后重复核对；
 * 并验证输入行序打乱不影响答案。
 */
test("随机路由表：trie 与线性扫描在每次修改后一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "rlab-diff-"));
  const service = new RouteService(new Store(join(dir, "r.db")));
  service.createTable("t");

  const probes: string[] = [];
  for (let i = 0; i < 128; i++) {
    probes.push(formatIPv4(BigInt(randomInt(0, 2 ** 32))));
  }
  probes.push("0.0.0.0", "255.255.255.255", "10.0.0.0", "10.255.255.255");

  const check = () => {
    const snap = service.snapshot("t");
    const out = service.queryBatch("t", probes);
    for (let i = 0; i < probes.length; i++) {
      const expected = linearScan(snap.routes, parseIPv4Strict(probes[i]!));
      const got = out.results[i]!;
      assert.equal(got.result, expected.result, `${probes[i]} result @v${snap.version}`);
      assert.equal(got.prefix, expected.prefix, `${probes[i]} prefix @v${snap.version}`);
      assert.equal(got.routeId, expected.routeId, `${probes[i]} routeId @v${snap.version}`);
      assert.equal(got.nextHop, expected.nextHop, `${probes[i]} nextHop @v${snap.version}`);
      assert.equal(out.version, snap.version);
    }
  };

  const rndRoute = (id: number): RouteInput => {
    const len = randomInt(0, 33);
    const addr = formatIPv4(BigInt(randomInt(0, 2 ** 32)));
    const action = randomInt(0, 4) === 0 ? "drop" : "forward";
    return {
      id: `r${id}`,
      cidr: `${addr}/${len}`,
      metric: randomInt(0, 10),
      enabled: randomInt(0, 5) !== 0,
      action,
      nextHop: action === "drop" ? null : `192.0.2.${randomInt(1, 254)}`,
    };
  };

  let version = 0;
  const routes: RouteInput[] = [];
  // 初始 30 条（分批导入）
  for (let n = 0; n < 30; n++) routes.push(rndRoute(n));
  version = service.bulkImport("t", routes.slice(0, 15), version).version;
  check();
  version = service.bulkImport("t", routes.slice(15), version).version;
  check();

  // 随机修改 40 轮
  let nextId = 30;
  for (let round = 0; round < 40; round++) {
    const kind = randomInt(0, 4);
    const existing = service.snapshot("t").routes;
    if (kind === 0) {
      const r = rndRoute(nextId++);
      routes.push(r);
      version = service.upsert("t", r, version).version;
    } else if (kind === 1 && existing.length > 0) {
      const r = existing[randomInt(0, existing.length)]!;
      version = service.remove("t", r.id, version);
    } else if (kind === 2 && existing.length > 0) {
      const r = existing[randomInt(0, existing.length)]!;
      version = service.setEnabled("t", r.id, !r.enabled, version);
    } else if (existing.length > 0) {
      const r = existing[randomInt(0, existing.length)]!;
      version = service.setMetric("t", r.id, randomInt(0, 100), version);
    }
    check();
  }

  // 行序不变性：打乱同一集合的导入顺序，所有查询结果必须相同
  const dir2 = mkdtempSync(join(tmpdir(), "rlab-diff2-"));
  const s2 = new RouteService(new Store(join(dir2, "a.db")));
  s2.createTable("t");
  const s3 = new RouteService(new Store(join(dir2, "b.db")));
  s3.createTable("t");
  const finalRoutes = service.snapshot("t").routes.map((r) => ({
    id: r.id,
    cidr: r.cidr,
    metric: r.metric,
    enabled: r.enabled,
    action: r.action,
    nextHop: r.nextHop,
  }));
  const shuffled = [...finalRoutes];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  s2.bulkImport("t", finalRoutes, 0);
  s3.bulkImport("t", shuffled, 0);
  const a = s2.queryBatch("t", probes);
  const b = s3.queryBatch("t", probes);
  for (let i = 0; i < probes.length; i++) {
    assert.equal(a.results[i]!.routeId, b.results[i]!.routeId, `顺序敏感 @ ${probes[i]}`);
    assert.equal(a.results[i]!.prefix, b.results[i]!.prefix);
  }
});
