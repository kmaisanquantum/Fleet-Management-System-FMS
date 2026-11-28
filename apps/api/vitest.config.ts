import os from "os";
import path from "path";
import { defineConfig } from "vitest/config";

// Each test run gets a fresh SQLite database so tests never write into the
// developer database. A single fork keeps the shared file from being opened by
// multiple workers at once.
const testDbPath = path.join(os.tmpdir(), `fms-vitest-${process.pid}-${Date.now()}.db`);

export default defineConfig({
  test: {
    env: { DB_PATH: testDbPath },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
