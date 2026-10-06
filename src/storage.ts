import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Route, RouteAction } from "./model.ts";

export interface RouteRecord {
  id: string;
  cidr: string;
  network: string;
  prefix_len: number;
  metric: number;
  enabled: number;
  action: RouteAction;
  next_hop: string | null;
}

export interface Snapshot {
  tableId: string;
  version: number;
  routes: Route[];
}

/**
 * SQLite 持久化。
 * tables 保存当前版本号；route_events 为仅追加的事件流，
 * 任意历史版本都可通过重放前 version 批事件精确重建。
 */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tables (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS route_events (
        table_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        op TEXT NOT NULL,
        route_id TEXT,
        payload TEXT,
        PRIMARY KEY (table_id, version, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_events_table ON route_events(table_id, version);
    `);
  }

  createTable(id: string): number {
    const exists = this.db.prepare("SELECT 1 FROM tables WHERE id = ?").get(id);
    if (exists) throw new StoreError("TABLE_EXISTS", `路由表已存在：${id}`);
    this.db.prepare("INSERT INTO tables(id, version, created_at) VALUES(?, 0, ?)").run(
      id,
      Date.now(),
    );
    return 0;
  }

  listTables(): Array<{ id: string; version: number }> {
    return this.db
      .prepare("SELECT id, version FROM tables ORDER BY id")
      .all()
      .map((r) => ({ id: r.id as string, version: r.version as number }));
  }

  currentVersion(tableId: string): number {
    const row = this.db.prepare("SELECT version FROM tables WHERE id = ?").get(tableId) as
      | { version: number }
      | undefined;
    if (!row) throw new StoreError("TABLE_NOT_FOUND", `路由表不存在：${tableId}`);
    return row.version;
  }

  /** 在一个事务内追加一批事件并推进版本；任何前置校验失败都不会写库（回滚） */
  commit(
    tableId: string,
    expectedVersion: number,
    events: Array<{ op: string; routeId?: string; payload?: unknown }>,
  ): number {
    this.currentVersion(tableId);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new StoreError("INVALID_VERSION", "期望版本必须为非负整数");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cur = this.currentVersion(tableId);
      if (cur !== expectedVersion) {
        throw new StoreError(
          "VERSION_CONFLICT",
          `版本冲突：当前 ${cur}，请求期望 ${expectedVersion}`,
        );
      }
      const next = cur + 1;
      const stmt = this.db.prepare(
        "INSERT INTO route_events(table_id, version, seq, op, route_id, payload) VALUES(?, ?, ?, ?, ?, ?)",
      );
      events.forEach((e, seq) => {
        stmt.run(
          tableId,
          next,
          seq,
          e.op,
          e.routeId ?? null,
          e.payload === undefined ? null : JSON.stringify(e.payload),
        );
      });
      this.db.prepare("UPDATE tables SET version = ? WHERE id = ?").run(next, tableId);
      this.db.exec("COMMIT");
      return next;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 重建指定版本（默认当前）的完整路由集合 */
  loadAtVersion(tableId: string, atVersion?: number): Snapshot {
    const current = this.currentVersion(tableId);
    const target = atVersion ?? current;
    if (target > current) {
      throw new StoreError(
        "VERSION_NOT_FOUND",
        `版本 ${target} 不存在（当前版本 ${current}）`,
      );
    }
    const rows = this.db
      .prepare(
        "SELECT op, route_id, payload FROM route_events WHERE table_id = ? AND version <= ? ORDER BY version, seq",
      )
      .all(tableId, target) as Array<{ op: string; route_id: string | null; payload: string | null }>;

    const byId = new Map<string, Route>();
    for (const row of rows) {
      if (row.op === "upsert" || row.op === "import") {
        const rec = JSON.parse(row.payload as string) as RouteRecord;
        byId.set(rec.id, recordToRoute(rec));
      } else if (row.op === "delete") {
        byId.delete(row.route_id as string);
      } else if (row.op === "set-enabled") {
        const payload = JSON.parse(row.payload as string) as { enabled: boolean };
        const r = byId.get(row.route_id as string);
        if (r) r.enabled = payload.enabled;
      } else if (row.op === "set-metric") {
        const payload = JSON.parse(row.payload as string) as { metric: number };
        const r = byId.get(row.route_id as string);
        if (r) r.metric = payload.metric;
      }
    }
    return { tableId, version: target, routes: [...byId.values()] };
  }

  close(): void {
    this.db.close();
  }
}

export function recordToRoute(rec: RouteRecord): Route {
  return {
    id: rec.id,
    cidr: rec.cidr,
    network: BigInt(rec.network),
    prefixLen: rec.prefix_len,
    metric: rec.metric,
    enabled: rec.enabled === 1,
    action: rec.action,
    nextHop: rec.next_hop,
  };
}

export function routeToRecord(r: Route): RouteRecord {
  return {
    id: r.id,
    cidr: r.cidr,
    network: r.network.toString(),
    prefix_len: r.prefixLen,
    metric: r.metric,
    enabled: r.enabled ? 1 : 0,
    action: r.action,
    next_hop: r.nextHop,
  };
}

export class StoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}
