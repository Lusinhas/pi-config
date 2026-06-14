import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VSCODE_EXTENSION_ID = "piconfig.idebridge";

interface Candidate {
  cmd: string;
  args: string[];
}

const INSTALL_TIMEOUT_MS = 30000;

export async function installVsCodeCompanion(): Promise<boolean> {
  const source = fileURLToPath(new URL("../../../../companion", import.meta.url));
  return copyExtensionDirectory(source);
}

export async function installVsCodeCompanionFromLocalDebugVsix(path: string): Promise<boolean> {
  const exists = await access(path).then(() => true).catch(() => false);
  if (!exists) return false;

  const meta = await stat(path);
  if (meta.isDirectory()) return copyExtensionDirectory(resolve(path));
  if (process.platform === "win32") return false;

  return installVsCodeExtension(path);
}

async function copyExtensionDirectory(source: string): Promise<boolean> {
  const manifest = await readManifest(source);
  if (!manifest) return false;

  const targetName = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
  let installed = false;

  for (const root of editorTargets()) {
    try {
      const target = join(root, targetName);
      await mkdir(root, { recursive: true });
      await rm(target, { recursive: true, force: true });
      await cp(source, target, { recursive: true });
      await registerExtension(root, targetName, manifest);
      installed = true;
    } catch {
      continue;
    }
  }

  return installed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function registerExtension(root: string, relativeLocation: string, manifest: { name: string; publisher: string; version: string }): Promise<void> {
  const file = join(root, "extensions.json");
  const id = `${manifest.publisher}.${manifest.name}`;
  let raw: string | undefined;

  try {
    raw = await readFile(file, "utf8");
  } catch {
    raw = undefined;
  }

  let list: unknown[] = [];

  if (raw !== undefined) {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      throw new Error("extensions.json is not a JSON array");
    }

    list = parsed;
  }

  const kept = list.filter((entry) => {
    const identifier = isRecord(entry) ? entry.identifier : undefined;
    const existingId = isRecord(identifier) && typeof identifier.id === "string" ? identifier.id : "";

    return existingId.toLowerCase() !== id.toLowerCase();
  });

  kept.push({
    identifier: { id },
    version: manifest.version,
    location: { "$mid": 1, path: join(root, relativeLocation), scheme: "file" },
    relativeLocation,
    metadata: {
      installedTimestamp: Date.now(),
      source: "vsix",
      pinned: true,
      updated: false,
      private: false,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false,
    },
  });

  await writeFile(file, JSON.stringify(kept));
}

async function readManifest(source: string): Promise<{ name: string; publisher: string; version: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" && record.name !== "" ? record.name : undefined;
    const publisher = typeof record.publisher === "string" && record.publisher !== "" ? record.publisher : undefined;
    const version = typeof record.version === "string" && record.version !== "" ? record.version : undefined;

    return name && publisher && version ? { name, publisher, version } : undefined;
  } catch {
    return undefined;
  }
}

function hasCli(...names: string[]): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");

  for (const name of names) {
    for (const dir of dirs) {
      if (existsSync(join(dir, name))) return true;
    }
  }

  return false;
}

function firstExisting(dirs: string[]): string {
  for (const dir of dirs) {
    if (existsSync(dir)) return dir;
  }

  return dirs[0];
}

function editorTargets(): string[] {
  const home = homedir();
  const targets: string[] = [];

  if (hasCli("code")) {
    targets.push(firstExisting([join(home, ".vscode", "extensions"), join(home, ".var", "app", "com.visualstudio.code", "data", "vscode", "extensions")]));
  }

  if (hasCli("code-insiders")) {
    targets.push(firstExisting([join(home, ".vscode-insiders", "extensions"), join(home, ".var", "app", "com.visualstudio.code.insiders", "data", "vscode-insiders", "extensions")]));
  }

  if (hasCli("codium", "code-oss")) {
    targets.push(firstExisting([join(home, ".vscode-oss", "extensions"), join(home, ".vscodium", "extensions"), join(home, ".var", "app", "com.vscodium.codium", "data", "vscode-oss", "extensions")]));
  }

  if (hasCli("cursor")) {
    targets.push(join(home, ".cursor", "extensions"));
  }

  if (hasCli("windsurf")) {
    targets.push(join(home, ".windsurf", "extensions"));
  }

  return [...new Set(targets)];
}

function installVsCodeExtension(extensionSpec: string): Promise<boolean> {
  return runCandidates(getCandidates(extensionSpec));
}

function getCandidates(extensionSpec: string): Candidate[] {
  const installArgs = ["--install-extension", extensionSpec, "--force"];
  return ["code", "code-insiders", "codium", "vscodium", "code-oss"].map((cmd) => ({ cmd, args: installArgs }));
}

async function runCandidates(candidates: Candidate[]): Promise<boolean> {
  for (const { cmd, args } of candidates) {
    if (await runCommand(cmd, args)) return true;
  }

  return false;
}

function runCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { stdio: "ignore", shell: false });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolvePromise(false);
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(false);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0);
    });
  });
}
