import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface IdeLock {
  port: number;
  pid: number;
  ideName: string;
  authToken: string;
  workspaceFolders: string[];
  transport: string;
  runningInWindows: boolean;
  mtimeMs: number;
  lockPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultLockDir(): string {
  return join(homedir(), ".claude", "ide");
}

export function discoverIdes(lockDir: string): IdeLock[] {
  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return [];
  }
  const locks: IdeLock[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const port = Number.parseInt(entry.slice(0, -5), 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) continue;
    const lockPath = join(lockDir, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    const folders = Array.isArray(parsed.workspaceFolders)
      ? parsed.workspaceFolders.filter((folder): folder is string => typeof folder === "string" && folder !== "")
      : [];
    locks.push({
      port,
      pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : 0,
      ideName: typeof parsed.ideName === "string" && parsed.ideName !== "" ? parsed.ideName : "IDE",
      authToken: typeof parsed.authToken === "string" ? parsed.authToken : "",
      workspaceFolders: folders,
      transport: typeof parsed.transport === "string" && parsed.transport !== "" ? parsed.transport : "ws",
      runningInWindows: parsed.runningInWindows === true,
      mtimeMs,
      lockPath,
    });
  }
  return locks;
}

export function isAlive(lock: IdeLock): boolean {
  if (lock.pid <= 0 || lock.runningInWindows) return true;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function matchesWorkspace(lock: IdeLock, cwd: string): boolean {
  const here = resolve(cwd);
  return lock.workspaceFolders.some((folder) => {
    const root = resolve(folder);
    return here === root || here.startsWith(root + sep);
  });
}

export function pickIde(locks: IdeLock[], cwd: string, manual: boolean): IdeLock | undefined {
  const alive = locks.filter((lock) => lock.transport === "ws" && isAlive(lock));
  const envPort = Number.parseInt(process.env.CLAUDE_CODE_SSE_PORT ?? "", 10);
  if (Number.isFinite(envPort)) {
    const fromEnv = alive.find((lock) => lock.port === envPort);
    if (fromEnv !== undefined) return fromEnv;
  }
  const byRecency = (a: IdeLock, b: IdeLock): number => b.mtimeMs - a.mtimeMs;
  const matching = alive.filter((lock) => matchesWorkspace(lock, cwd)).sort(byRecency);
  if (matching.length > 0) return matching[0];
  return manual ? alive.sort(byRecency)[0] : undefined;
}
