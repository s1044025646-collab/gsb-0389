import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Store } from "../src/storage.ts";
import { RouteService } from "../src/service.ts";
import { startHttp, type RunningServer } from "../src/server.ts";

let running: RunningServer;
let base: string;

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "rlab-api-"));
  const service = new RouteService(new Store(join(dir, "api.db")));
  running = await startHttp(service, {});
  base = `http://${running.host}:${running.port}/api`;
});

after(async () => {
  running.server.close();
  await once(running.server, "close");
});

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: await res.json() };
}

test("HTTP 端到端：建表、导入、查询、版本冲突、错误码", async () => {
  assert.equal((await call("/health")).status, 200);

  const created = await call("/tables", { method: "POST", body: JSON.stringify({ id: "net" }) });
  assert.equal(created.status, 201);

  const dup = await call("/tables", { method: "POST", body: JSON.stringify({ id: "net" }) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "TABLE_EXISTS");

  const bad = await call("/tables/net/routes/import", {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: 0,
      routes: [{ id: "x", cidr: "300.0.0.0/8", nextHop: "1.1.1.1" }],
    }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "IP_INVALID");
  // 失败回滚：没有任何路由
  const empty = await call("/tables/net/routes");
  assert.equal(empty.body.routes.length, 0);

  const imp = await call("/tables/net/routes/import", {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: 0,
      routes: [
        { id: "d", cidr: "0.0.0.0/0", nextHop: "8.8.8.8", metric: 9 },
        { id: "h", cidr: "10.1.2.0/24", action: "drop" },
      ],
    }),
  });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.version, 1);

  const stale = await call("/tables/net/enabled", {
    method: "POST",
    body: JSON.stringify({ id: "h", enabled: false, expectedVersion: 0 }),
  });
  assert.equal(stale.status, 409);

  const q = await call("/tables/net/query", {
    method: "POST",
    body: JSON.stringify({ destination: "10.1.2.7" }),
  });
  assert.equal(q.body.result, "drop");
  assert.equal(q.body.version, 1);

  const batch = await call("/tables/net/query", {
    method: "POST",
    body: JSON.stringify({ destinations: ["10.1.2.7", "1.2.3.4", "255.255.255.255"] }),
  });
  assert.equal(batch.body.results.length, 3);
  assert.equal(batch.body.results[1].routeId, "d");

  const tree = await call("/tables/net/tree");
  assert.equal(tree.body.tree.cidr, "0.0.0.0/0");

  const hist = await call("/tables/net/routes?version=0");
  assert.equal(hist.body.version, 0);
  assert.equal(hist.body.routes.length, 0);
});
