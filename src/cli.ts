#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppContext } from "./app";
import { createHttpServer, listen } from "./http";
import { AppError } from "./errors";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const dataDir = process.env.LPM_DATA_DIR ?? join(process.cwd(), "data");
const dbPath = process.env.LPM_DB_PATH ?? join(dataDir, "routes.sqlite");

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function main(): Promise<void> {
  const context = createAppContext(dbPath);
  try {
    const service = context.service;
    switch (command) {
      case "serve": {
        const portIndex = args.indexOf("--port");
        const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.PORT ?? 0);
        const hostIndex = args.indexOf("--host");
        const host = hostIndex >= 0 ? args[hostIndex + 1] : "127.0.0.1";
        const actualPort = await listen(createHttpServer(service), port, host);
        process.stdout.write(`IPv4 LPM 服务已启动: http://${host}:${actualPort}\n`);
        break;
      }
      case "create-table": {
        print(service.createTable({ name: args[1] }));
        break;
      }
      case "list-tables":
        print({ tables: service.listTables() });
        break;
      case "import": {
        const [, tableId, file] = args;
        const payload = parseJsonFile(file) as { routes: unknown; expectedVersion?: unknown };
        print(service.importRoutes(tableId, payload.routes, payload));
        break;
      }
      case "add": {
        const [, tableId, file] = args;
        const payload = parseJsonFile(file) as { route?: unknown; expectedVersion?: unknown };
        print(service.importRoutes(tableId, [payload.route ?? payload], payload));
        break;
      }
      case "delete": {
        const [, tableId, routeId, expectedVersion] = args;
        print(service.deleteRoute(tableId, routeId, { expectedVersion }));
        break;
      }
      case "enable":
      case "disable": {
        const [, tableId, routeId, expectedVersion] = args;
        print(service.setEnabled(tableId, routeId, command === "enable", { expectedVersion }));
        break;
      }
      case "metric": {
        const [, tableId, routeId, metricValue, expectedVersion] = args;
        print(service.updateMetric(tableId, routeId, metricValue, { expectedVersion }));
        break;
      }
      case "lookup": {
        const [, tableId, destination, version] = args;
        print(service.lookup(tableId, {
          destination,
          version
        }));
        break;
      }
      case "batch-lookup": {
        const [, tableId, file] = args;
        const payload = parseJsonFile(file) as { destinations: unknown; version?: unknown };
        print(service.batchLookup(tableId, payload.destinations, payload.version));
        break;
      }
      case "tree-path": {
        const [, tableId, destination, version] = args;
        print(service.treePath(tableId, destination, version));
        break;
      }
      case "snapshot": {
        const [, tableId, version] = args;
        const result = service.snapshot(tableId, version);
        print(result);
        if (args.includes("--file")) {
          const file = args[args.indexOf("--file") + 1];
          writeFileSync(file, JSON.stringify(result, null, 2), "utf8");
        }
        break;
      }
      case "versions":
        print(service.listVersions(args[1]));
        break;
      case "help":
      default:
        process.stdout.write(`用法:
  npm run build
  node dist/cli.js serve [--port 8080] [--host 127.0.0.1]
  node dist/cli.js create-table [name]
  node dist/cli.js import <tableId> <routes.json>
  node dist/cli.js add <tableId> <route.json>
  node dist/cli.js lookup <tableId> <destination> [version]
  node dist/cli.js batch-lookup <tableId> <destinations.json>
  node dist/cli.js tree-path <tableId> <destination> [version]
  node dist/cli.js snapshot <tableId> [version] [--file out.json]
  node dist/cli.js enable|disable|delete <tableId> <routeId> <expectedVersion>
  node dist/cli.js metric <tableId> <routeId> <metric> <expectedVersion>
  node dist/cli.js versions <tableId>
`);
    }
  } finally {
    if (command !== "serve") context.database.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
