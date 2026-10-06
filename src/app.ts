import { join } from "node:path";
import { RouteDatabase } from "./db";
import { createHttpServer } from "./http";
import { RouteService } from "./service";

export interface AppContext {
  database: RouteDatabase;
  service: RouteService;
}

export function createAppContext(databasePath = join(process.cwd(), "data", "routes.sqlite")): AppContext {
  const database = new RouteDatabase(databasePath);
  const service = new RouteService(database);
  return { database, service };
}

export { createHttpServer };
