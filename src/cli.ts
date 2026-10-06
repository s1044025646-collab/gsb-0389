#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { Store } from "./storage.ts";
import { RouteService } from "./service.ts";
import { startHttp } from "./server.ts";
import { runDemo } from "./demo.ts";

const DEFAULT_DB = resolve("data/routes.db");

function usage(): never {
  console.error(`用法:
  route-lab serve [--port N] [--host H] [--db PATH]
  route-lab demo [--db PATH]
  route-lab create-table <id> [--db PATH]
  route-lab list-tables [--db PATH]
  route-lab import <tableId> <expectedVersion> <jsonArrayFile> [--db PATH]
  route-lab upsert <tableId> <expectedVersion> '<routeJson>' [--db PATH]
  route-lab delete <tableId> <expectedVersion> <routeId> [--db PATH]
  route-lab enable|disable <tableId> <expectedVersion> <routeId> [--db PATH]
  route-lab metric <tableId> <expectedVersion> <routeId> <n> [--db PATH]
  route-lab query <tableId> <ip...> [--version N] [--db PATH]
  route-lab tree <tableId> [--version N] [--db PATH]
  route-lab export <tableId> [--version N] [--db PATH]

默认数据库：${DEFAULT_DB}（项目内 data 目录，可通过 --db 覆盖）
端口默认选择空闲端口。`);
  process.exit(2);
}

interface Parsed {
  args: string[];
  flags: Map<string, string>;
}

function parse(argv: string[]): Parsed {
  const args: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function openService(flags: Map<string, string>): { service: RouteService; db: string } {
  const db = resolve(flags.get("db") ?? DEFAULT_DB);
  mkdirSync(resolve(db, ".."), { recursive: true });
  return { service: new RouteService(new Store(db)), db };
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const { args, flags } = parse(process.argv.slice(2));
  const cmd = args[0];
  if (!cmd) usage();

  if (cmd === "serve") {
    const { service, db } = openService(flags);
    const port = flags.has("port") ? Number(flags.get("port")) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      console.error("端口必须为 1..65535 的整数");
      process.exit(2);
    }
    const host = flags.get("host") ?? "127.0.0.1";
    const running = await startHttp(service, { port, host });
    console.log(JSON.stringify({
      status: "listening",
      host: running.host,
      port: running.port,
      db,
      api: `http://${running.host}:${running.port}/api`,
    }, null, 2));
    const shutdown = () => {
      running.server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (cmd === "demo") {
    const { service } = openService(flags);
    await runDemo(service, print);
    return;
  }

  const { service } = openService(flags);
  const versionFlag = flags.has("version") ? Number(flags.get("version")) : undefined;

  switch (cmd) {
    case "create-table":
      print(service.createTable(requireArg(args[1], "tableId")));
      break;
    case "list-tables":
      print({ tables: service.listTables() });
      break;
    case "import": {
      const [, tableId, expectedStr, file] = args;
      const { readFileSync } = await import("node:fs");
      const arr = JSON.parse(readFileSync(requireArg(file, "jsonArrayFile"), "utf8"));
      print(service.bulkImport(requireArg(tableId, "tableId"), arr, intArg(expectedStr, "expectedVersion")));
      break;
    }
    case "upsert":
      print(
        service.upsert(
          requireArg(args[1], "tableId"),
          JSON.parse(requireArg(args[3], "routeJson")),
          intArg(args[2], "expectedVersion"),
        ),
      );
      break;
    case "delete":
      print({
        version: service.remove(
          requireArg(args[1], "tableId"),
          requireArg(args[3], "routeId"),
          intArg(args[2], "expectedVersion"),
        ),
      });
      break;
    case "enable":
    case "disable":
      print({
        version: service.setEnabled(
          requireArg(args[1], "tableId"),
          requireArg(args[3], "routeId"),
          cmd === "enable",
          intArg(args[2], "expectedVersion"),
        ),
      });
      break;
    case "metric":
      print({
        version: service.setMetric(
          requireArg(args[1], "tableId"),
          requireArg(args[3], "routeId"),
          intArg(args[4], "metric"),
          intArg(args[2], "expectedVersion"),
        ),
      });
      break;
    case "query": {
      const tableId = requireArg(args[1], "tableId");
      const ips = args.slice(2);
      if (ips.length === 0) usage();
      print(
        ips.length === 1
          ? service.query(tableId, ips[0]!, versionFlag)
          : service.queryBatch(tableId, ips, versionFlag),
      );
      break;
    }
    case "tree":
      print(service.tree(requireArg(args[1], "tableId"), versionFlag));
      break;
    case "export":
      print(service.snapshot(requireArg(args[1], "tableId"), versionFlag));
      break;
    default:
      usage();
  }
}

function requireArg(v: string | undefined, name: string): string {
  if (v === undefined || v === "") {
    console.error(`缺少参数：${name}`);
    process.exit(2);
  }
  return v;
}

function intArg(v: string | undefined, name: string): number {
  const n = Number(requireArg(v, name));
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name} 必须为非负整数`);
    process.exit(2);
  }
  return n;
}

main().catch((err: Error & { code?: string }) => {
  console.error(JSON.stringify({ error: { code: err.code ?? "INTERNAL", message: err.message } }, null, 2));
  process.exit(1);
});
