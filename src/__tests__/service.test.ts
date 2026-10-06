import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouteDatabase } from "../db";
import { parseIpv4 } from "../ipv4";
import { normalizeRouteInput } from "../route";
import { linearScanLookup, randomIpv4 } from "../scanner";
import { RouteService } from "../service";
import { RouteTrie } from "../trie";
import { RouteInput } from "../types";

function makeService(fileName: string) {
  const dir = mkdtempSync(join(tmpdir(), "ipv4-lpm-"));
  const dbPath = join(dir, fileName);
  const database = new RouteDatabase(dbPath);
  const service = new RouteService(database);
  return {
    dir,
    dbPath,
    database,
    service,
    close: () => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function route(routeId: number, cidr: string, metric = 0, extra: Partial<RouteInput> = {}): RouteInput {
  return {
    routeId,
    cidr,
    metric,
    enabled: true,
    action: cidr.includes("drop") ? "drop" : "forward",
    nextHop: cidr.includes("drop") ? undefined : `192.0.2.${routeId}`,
    ...extra
  };
}

test("演示规则、禁用 /16 后正确回退 /8", () => {
  const context = makeService("demo.sqlite");
  try {
    const table = context.service.createTable({ name: "demo" });
    const imported = context.service.importRoutes(table.table_id, [
      { routeId: 1, cidr: "0.0.0.0/0", metric: 100, action: "forward", nextHop: "192.0.2.1" },
      { routeId: 2, cidr: "10.0.0.0/8", metric: 20, action: "forward", nextHop: "192.0.2.10" },
      { routeId: 3, cidr: "10.1.0.0/16", metric: 10, action: "forward", nextHop: "192.0.2.16" },
      { routeId: 4, cidr: "10.1.2.0/24", metric: 1, action: "drop" }
    ], { expectedVersion: 0 });
    assert.equal(imported.version, 1);
    assert.equal(context.service.lookup(table.table_id, { destination: "10.1.2.9" }).outcome, "drop");
    assert.equal(context.service.lookup(table.table_id, { destination: "10.1.3.9" }).matchedPrefix, "10.1.0.0/16");
    context.service.setEnabled(table.table_id, 3, false, { expectedVersion: 1 });
    const fallback = context.service.lookup(table.table_id, { destination: "10.1.3.9" });
    assert.equal(fallback.matchedPrefix, "10.0.0.0/8");
    assert.equal(fallback.selectedRouteId, 2);
    const oldReport = context.service.lookup(table.table_id, { destination: "10.1.3.9", version: 1 });
    assert.equal(oldReport.version, 1);
    assert.equal(oldReport.selectedRouteId, 3);
  } finally {
    context.close();
  }
});

test("任一非法批量条目整批拒绝且不增加版本", () => {
  const context = makeService("batch.sqlite");
  try {
    const table = context.service.createTable({});
    assert.throws(() => context.service.importRoutes(table.table_id, [
      { routeId: 1, cidr: "10.0.0.0/8", metric: 0, action: "forward", nextHop: "1.1.1.1" },
      { routeId: 2, cidr: "10.0.0.0/33", metric: 0, action: "forward", nextHop: "1.1.1.2" }
    ], { expectedVersion: 0 }), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "BATCH_VALIDATION_FAILED");
    const snapshot = context.service.snapshot(table.table_id);
    assert.equal(snapshot.version, 0);
    assert.equal(snapshot.routes.length, 0);
    assert.throws(() => context.service.importRoutes(table.table_id, [
      { routeId: 1, cidr: "10.0.0.0/8", metric: 0, action: "forward", nextHop: "1.1.1.1" },
      { routeId: 1, cidr: "11.0.0.0/8", metric: 0, action: "forward", nextHop: "1.1.1.2" }
    ], { expectedVersion: 0 }), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "BATCH_VALIDATION_FAILED");
  } finally {
    context.close();
  }
});

test("删父留子、删子留父、全删版本仍可历史复现，重启后结果不变", () => {
  const context = makeService("persist.sqlite");
  try {
    const table = context.service.createTable({});
    context.service.importRoutes(table.table_id, [
      { routeId: 1, cidr: "10.0.0.0/8", metric: 0, action: "forward", nextHop: "1.1.1.1" },
      { routeId: 2, cidr: "10.0.0.0/32", metric: 0, action: "forward", nextHop: "2.2.2.2" }
    ], { expectedVersion: 0 });
    context.service.deleteRoute(table.table_id, 1, { expectedVersion: 1 });
    assert.equal(context.service.lookup(table.table_id, { destination: "10.0.0.0" }).selectedRouteId, 2);
    context.service.deleteRoute(table.table_id, 2, { expectedVersion: 2 });
    assert.equal(context.service.lookup(table.table_id, { destination: "10.0.0.0" }).outcome, "no-route");
    assert.equal(context.service.lookup(table.table_id, { destination: "10.0.0.0", version: 2 }).selectedRouteId, 2);
    context.database.close();
    const restartedDb = new RouteDatabase(context.dbPath);
    const restarted = new RouteService(restartedDb);
    assert.equal(restarted.lookup(table.table_id, { destination: "10.0.0.0", version: 1 }).selectedRouteId, 2);
    assert.equal(restarted.lookup(table.table_id, { destination: "10.0.0.1", version: 1 }).selectedRouteId, 1);
    restartedDb.close();
  } finally {
    context.close();
  }
});

test("随机小路由表每次修改后与独立掩码线性扫描一致，输入行序不影响答案", () => {
  const context = makeService("random.sqlite");
  try {
    let seed = 123456789;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const table = context.service.createTable({});
    const inputs: RouteInput[] = [];
    for (let routeId = 1; routeId <= 40; routeId += 1) {
      const prefixLength = Math.floor(random() * 33);
      const cidr = `${randomIpv4(random)}/${prefixLength}`;
      const action = random() > 0.15 ? "forward" : "drop";
      const normalized = normalizeRouteInput({
        routeId,
        cidr,
        metric: Math.floor(random() * 5),
        action,
        nextHop: action === "forward" ? randomIpv4(random) : undefined,
        enabled: random() > 0.2
      });
      inputs.push({
        routeId,
        cidr: normalized.cidr,
        metric: normalized.metric,
        enabled: normalized.enabled,
        action: normalized.action,
        nextHop: normalized.nextHop
      });
    }
    let version = 0;
    const shuffled = [...inputs].sort(() => random() - 0.5);
    const imported = context.service.importRoutes(table.table_id, shuffled, { expectedVersion: version });
    version = imported.version;
    const destinations = Array.from({ length: 100 }, () => randomIpv4(random));
    const check = (checkVersion: number) => {
      const routes = context.database.getSnapshotRoutes(table.table_id, checkVersion);
      const trie = new RouteTrie(routes);
      for (const destinationText of destinations) {
        const destination = parseIpv4(destinationText);
        const trieResult = trie.lookup(destination, destinationText, checkVersion);
        const scanResult = linearScanLookup(routes, destination, destinationText, checkVersion);
        assert.equal(trieResult.outcome, scanResult.outcome, destinationText);
        assert.equal(trieResult.selectedRouteId, scanResult.selectedRouteId, destinationText);
      }
    };
    check(version);
    const metricUpdated = context.service.updateMetric(table.table_id, 1, 0, { expectedVersion: version });
    version = metricUpdated.version;
    check(version);
    const disabled = context.service.setEnabled(table.table_id, 2, false, { expectedVersion: version });
    version = disabled.version;
    check(version);
    const deleted = context.service.deleteRoute(table.table_id, 3, { expectedVersion: version });
    version = deleted.version;
    check(version);
  } finally {
    context.close();
  }
});

test("过期 expectedVersion 导致写失败，不产生新版本", () => {
  const context = makeService("version.sqlite");
  try {
    const table = context.service.createTable({});
    const first = context.service.importRoutes(table.table_id, [
      { routeId: 1, cidr: "10.0.0.0/8", metric: 0, action: "forward", nextHop: "1.1.1.1" }
    ], { expectedVersion: 0 });
    assert.throws(() => context.service.setEnabled(table.table_id, 1, false, { expectedVersion: 0 }), (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "VERSION_CONFLICT");
    assert.equal(context.service.getTable(table.table_id).version, first.version);
  } finally {
    context.close();
  }
});
