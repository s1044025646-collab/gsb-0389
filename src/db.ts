import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { NormalizedRouteInput, Route, RouteAction } from "./types";

export interface RouteRow {
  route_id: number;
  cidr: string;
  network: number;
  prefix_length: number;
  metric: number;
  enabled: number;
  action: RouteAction;
  next_hop: string | null;
}

export interface TableRow {
  table_id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export class RouteDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_tables (
        table_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS routes (
        table_id TEXT NOT NULL REFERENCES route_tables(table_id) ON DELETE CASCADE,
        route_id INTEGER NOT NULL CHECK (route_id >= 0),
        cidr TEXT NOT NULL,
        network INTEGER NOT NULL,
        prefix_length INTEGER NOT NULL CHECK (prefix_length BETWEEN 0 AND 32),
        metric INTEGER NOT NULL CHECK (metric >= 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        action TEXT NOT NULL CHECK (action IN ('forward','drop')),
        next_hop TEXT,
        PRIMARY KEY (table_id, route_id)
      );
      CREATE TABLE IF NOT EXISTS route_snapshots (
        table_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        route_id INTEGER NOT NULL,
        cidr TEXT NOT NULL,
        network INTEGER NOT NULL,
        prefix_length INTEGER NOT NULL,
        metric INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        action TEXT NOT NULL,
        next_hop TEXT,
        PRIMARY KEY (table_id, version, route_id)
      );
      CREATE TABLE IF NOT EXISTS route_versions (
        table_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TEXT NOT NULL,
        PRIMARY KEY (table_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_version ON route_snapshots(table_id, version);
    `);
  }

  createTable(tableId: string, name: string, now: string): TableRow {
    this.db
      .prepare(
        `INSERT INTO route_tables(table_id, name, version, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`
      )
      .run(tableId, name, now, now);
    return this.getTableOrThrow(tableId);
  }

  getTable(tableId: string): TableRow | undefined {
    return this.db.prepare("SELECT * FROM route_tables WHERE table_id = ?").get(tableId) as
      | TableRow
      | undefined;
  }

  getTableOrThrow(tableId: string): TableRow {
    const table = this.getTable(tableId);
    if (!table) {
      const error = new Error(`ROUTE_TABLE_NOT_FOUND:${tableId}`);
      (error as Error & { code?: string }).code = "ROUTE_TABLE_NOT_FOUND";
      throw error;
    }
    return table;
  }

  listTables(): TableRow[] {
    return this.db.prepare("SELECT * FROM route_tables ORDER BY created_at, table_id").all() as unknown as TableRow[];
  }

  countRoutes(tableId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM routes WHERE table_id = ?")
      .get(tableId) as { count: number };
    return Number(row.count);
  }

  getRoute(tableId: string, routeId: number): RouteRow | undefined {
    return this.db
      .prepare("SELECT * FROM routes WHERE table_id = ? AND route_id = ?")
      .get(tableId, routeId) as RouteRow | undefined;
  }

  getCurrentRoutes(tableId: string): Route[] {
    return this.toRoutes(
      this.db
        .prepare("SELECT * FROM routes WHERE table_id = ? ORDER BY route_id")
        .all(tableId) as unknown as RouteRow[]
    );
  }

  getSnapshotRoutes(tableId: string, version: number): Route[] {
    return this.toRoutes(
      this.db
        .prepare(
          "SELECT route_id, cidr, network, prefix_length, metric, enabled, action, next_hop FROM route_snapshots WHERE table_id = ? AND version = ? ORDER BY route_id"
        )
        .all(tableId, version) as unknown as RouteRow[]
    );
  }

  listVersions(tableId: string): number[] {
    const rows = this.db
      .prepare("SELECT version FROM route_versions WHERE table_id = ? ORDER BY version")
      .all(tableId) as Array<{ version: number }>;
    return rows.map((row) => Number(row.version));
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertRoute(tableId: string, route: NormalizedRouteInput): void {
    this.db
      .prepare(
        `INSERT INTO routes(table_id, route_id, cidr, network, prefix_length, metric, enabled, action, next_hop)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tableId,
        route.routeId,
        route.cidr,
        route.network,
        route.prefixLength,
        route.metric,
        route.enabled ? 1 : 0,
        route.action,
        route.nextHop
      );
  }

  deleteRoute(tableId: string, routeId: number): void {
    this.db.prepare("DELETE FROM routes WHERE table_id = ? AND route_id = ?").run(tableId, routeId);
  }

  setRouteEnabled(tableId: string, routeId: number, enabled: boolean): void {
    this.db
      .prepare("UPDATE routes SET enabled = ? WHERE table_id = ? AND route_id = ?")
      .run(enabled ? 1 : 0, tableId, routeId);
  }

  setMetric(tableId: string, routeId: number, metric: number): void {
    this.db.prepare("UPDATE routes SET metric = ? WHERE table_id = ? AND route_id = ?").run(
      metric,
      tableId,
      routeId
    );
  }

  commitVersion(tableId: string, version: number, now: string): void {
    this.db
      .prepare("INSERT INTO route_versions(table_id, version, created_at) VALUES (?, ?, ?)")
      .run(tableId, version, now);
    this.db
      .prepare(
        `INSERT INTO route_snapshots(table_id, version, route_id, cidr, network, prefix_length, metric, enabled, action, next_hop)
         SELECT ?, ?, route_id, cidr, network, prefix_length, metric, enabled, action, next_hop
         FROM routes WHERE table_id = ?`
      )
      .run(tableId, version, tableId);
    this.db
      .prepare("UPDATE route_tables SET version = ?, updated_at = ? WHERE table_id = ?")
      .run(version, now, tableId);
  }

  private toRoutes(rows: RouteRow[]): Route[] {
    return rows.map((row) => ({
      routeId: Number(row.route_id),
      cidr: row.cidr,
      network: Number(row.network) >>> 0,
      prefixLength: Number(row.prefix_length),
      metric: Number(row.metric),
      enabled: Number(row.enabled) === 1,
      action: row.action,
      nextHop: row.next_hop
    }));
  }
}
