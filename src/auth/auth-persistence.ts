/**
 * Durable, deliberately boring primitives for authentication recovery.
 *
 * `state.json` is a recovery snapshot, never the source of truth for the
 * persistent Chrome profile.  The helpers in this file do not log contents:
 * these files contain bearer cookies.
 */
import { randomBytes } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import lockfile from "proper-lockfile";

const execFileAsync = promisify(execFile);
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const CRITICAL = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "OSID",
  "__Secure-OSID",
  "__Secure-1PSID",
  "__Secure-3PSID",
]);

export type SnapshotEvidence = "none" | "session_only" | "persistent" | "invalid";
export type AuthStatus =
  | "runtime_verified"
  | "snapshot_usable"
  | "snapshot_indeterminate"
  | "snapshot_missing"
  | "snapshot_malformed"
  | "snapshot_expired"
  | "not_authenticated";
export interface AuthHealthClassification {
  authenticated: boolean;
  auth_status: AuthStatus;
  auth_evidence: string;
}
export interface SnapshotInspection {
  usable: boolean;
  bootstrapEligible: boolean;
  evidence: SnapshotEvidence;
  criticalPersistent: number;
  criticalSessionOnly: number;
  invalidCritical: number;
  reason: string;
  state?: unknown;
}

export function isGoogleCookieDomain(domain: unknown): domain is string {
  if (typeof domain !== "string") return false;
  const normalized = domain.toLowerCase().replace(/^\./, "");
  return normalized === "google.com" || normalized.endsWith(".google.com");
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

/** Classify each duplicate independently; one good persistent critical cookie is evidence. */
export function inspectStorageState(value: unknown, now = Date.now() / 1000): SnapshotInspection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !hasOnlyKeys(value, ["cookies", "origins"]) ||
    !Array.isArray((value as { cookies?: unknown }).cookies) ||
    !Array.isArray((value as { origins?: unknown }).origins)
  ) {
    return {
      usable: false,
      bootstrapEligible: false,
      evidence: "invalid",
      criticalPersistent: 0,
      criticalSessionOnly: 0,
      invalidCritical: 0,
      reason: "invalid_storage_state",
    };
  }
  const root = value as { cookies: unknown[]; origins: unknown[] };
  const cookies = root.cookies;
  if (cookies.length > 512 || root.origins.length > 64)
    return {
      usable: false,
      bootstrapEligible: false,
      evidence: "invalid",
      criticalPersistent: 0,
      criticalSessionOnly: 0,
      invalidCritical: 0,
      reason: "invalid_storage_state",
    };
  let persistent = 0,
    session = 0,
    invalid = 0,
    malformed = false;
  for (const origin of root.origins) {
    if (!origin || typeof origin !== "object") {
      malformed = true;
      continue;
    }
    const o = origin as { origin?: unknown; localStorage?: unknown };
    if (
      Array.isArray(origin) ||
      Object.getPrototypeOf(origin) !== Object.prototype ||
      !hasOnlyKeys(origin, ["origin", "localStorage"]) ||
      typeof o.origin !== "string" ||
      o.origin.length > 2048
    ) {
      malformed = true;
      continue;
    }
    try {
      const parsed = new URL(o.origin);
      if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== o.origin) malformed = true;
    } catch {
      malformed = true;
    }
    if (!Array.isArray(o.localStorage) || o.localStorage.length > 256) {
      malformed = true;
      continue;
    }
    for (const entry of o.localStorage) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.getPrototypeOf(entry) !== Object.prototype ||
        !hasOnlyKeys(entry, ["name", "value"]) ||
        typeof (entry as { name?: unknown }).name !== "string" ||
        typeof (entry as { value?: unknown }).value !== "string" ||
        (entry as { name: string }).name.length > 2048 ||
        (entry as { value: string }).value.length > 65536
      )
        malformed = true;
    }
  }
  for (const cookie of cookies) {
    if (!cookie || typeof cookie !== "object") {
      malformed = true;
      continue;
    }
    const c = cookie as {
      name?: unknown;
      value?: unknown;
      domain?: unknown;
      path?: unknown;
      expires?: unknown;
      httpOnly?: unknown;
      secure?: unknown;
      sameSite?: unknown;
    };
    if (
      typeof c.name !== "string" ||
      Array.isArray(cookie) ||
      Object.getPrototypeOf(cookie) !== Object.prototype ||
      !hasOnlyKeys(cookie, [
        "name",
        "value",
        "domain",
        "path",
        "expires",
        "httpOnly",
        "secure",
        "sameSite",
      ]) ||
      typeof c.value !== "string" ||
      typeof c.domain !== "string" ||
      typeof c.path !== "string" ||
      c.name.length > 256 ||
      c.value.length > 8192 ||
      c.domain.length > 255 ||
      c.path.length > 2048 ||
      !c.path.startsWith("/") ||
      typeof c.httpOnly !== "boolean" ||
      typeof c.secure !== "boolean" ||
      !["Strict", "Lax", "None"].includes(String(c.sameSite)) ||
      typeof c.expires !== "number" ||
      !Number.isFinite(c.expires) ||
      (c.expires < 0 && c.expires !== -1)
    ) {
      malformed = true;
      continue;
    }
    if (!CRITICAL.has(c.name) || !isGoogleCookieDomain(c.domain)) continue;
    if (c.expires === -1) {
      session++;
      continue;
    }
    // Strict schema validation above proves expires is a finite number.
    if (c.expires > now) persistent++;
    else invalid++;
  }
  if (malformed)
    return {
      usable: false,
      bootstrapEligible: false,
      evidence: "invalid",
      criticalPersistent: persistent,
      criticalSessionOnly: session,
      invalidCritical: invalid,
      reason: "snapshot_malformed_or_unsafe",
      state: value,
    };
  if (persistent)
    return {
      usable: true,
      bootstrapEligible: true,
      evidence: "persistent",
      criticalPersistent: persistent,
      criticalSessionOnly: session,
      invalidCritical: invalid,
      reason: "persistent_critical_cookie",
      state: value,
    };
  if (session)
    return {
      usable: false,
      bootstrapEligible: true,
      evidence: "session_only",
      criticalPersistent: 0,
      criticalSessionOnly: session,
      invalidCritical: invalid,
      reason: "session_only_critical_cookie",
      state: value,
    };
  return {
    usable: false,
    bootstrapEligible: false,
    evidence: malformed || invalid ? "invalid" : "none",
    criticalPersistent: 0,
    criticalSessionOnly: 0,
    invalidCritical: invalid,
    reason: malformed
      ? "snapshot_malformed_or_unsafe"
      : invalid
        ? "snapshot_expired"
        : "no_google_critical_cookie",
    state: value,
  };
}

/** Offline-only health classification. It does not claim Google accepts a snapshot. */
export function classifyAuthHealth(
  snapshot: SnapshotInspection,
  runtimeVerified: boolean
): AuthHealthClassification {
  if (runtimeVerified)
    return {
      authenticated: true,
      auth_status: "runtime_verified",
      auth_evidence: "live_notebooklm_readiness",
    };
  if (snapshot.usable)
    return {
      authenticated: true,
      auth_status: "snapshot_usable",
      auth_evidence: snapshot.reason,
    };
  if (snapshot.bootstrapEligible)
    return {
      authenticated: false,
      auth_status: "snapshot_indeterminate",
      auth_evidence: snapshot.reason,
    };
  if (snapshot.reason === "snapshot_missing")
    return {
      authenticated: false,
      auth_status: "snapshot_missing",
      auth_evidence: snapshot.reason,
    };
  if (
    snapshot.reason === "snapshot_malformed_or_unsafe" ||
    snapshot.reason === "invalid_storage_state"
  )
    return {
      authenticated: false,
      auth_status: "snapshot_malformed",
      auth_evidence: snapshot.reason,
    };
  if (snapshot.reason === "snapshot_expired" || snapshot.invalidCritical > 0)
    return {
      authenticated: false,
      auth_status: "snapshot_expired",
      auth_evidence: snapshot.reason,
    };
  return {
    authenticated: false,
    auth_status: "not_authenticated",
    auth_evidence: snapshot.reason,
  };
}

function unsafeMode(mode: number): boolean {
  return (mode & 0o077) !== 0;
}
async function safeParent(dir: string): Promise<void> {
  const st = await fsp.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || unsafeMode(st.mode))
    throw new Error("unsafe auth-state directory");
  if (process.platform !== "win32" && st.uid !== process.getuid?.())
    throw new Error("auth-state directory owner mismatch");
}

/** Bounded, no-follow snapshot read with fstat/lstat identity check. */
export async function readSecureJson(
  file: string,
  maxBytes = MAX_SNAPSHOT_BYTES
): Promise<unknown> {
  await safeParent(path.dirname(file));
  const before = await fsp.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || unsafeMode(before.mode))
    throw new Error("unsafe auth snapshot");
  if (process.platform !== "win32" && before.uid !== process.getuid?.())
    throw new Error("auth snapshot owner mismatch");
  if (before.size > maxBytes) throw new Error("auth snapshot too large");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size !== before.size ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw new Error("auth snapshot changed while opening");
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(data, offset, stat.size - offset, offset);
      if (bytesRead === 0) throw new Error("short auth snapshot read");
      offset += bytesRead;
    }
    const after = await fsp.lstat(file);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size)
      throw new Error("auth snapshot changed while reading");
    return JSON.parse(data.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function writeSecureJson(file: string, value: unknown): Promise<void> {
  const dir = path.dirname(file);
  try {
    await fsp.lstat(dir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await safeParent(dir);
  await fsp.chmod(dir, 0o700);
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_SNAPSHOT_BYTES) throw new Error("auth snapshot too large");
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    const h = await fsp.open(
      temp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      await h.writeFile(body);
      await h.sync();
    } finally {
      await h.close();
    }
    await fsp.rename(temp, file);
    const dh = await fsp.open(dir, fs.constants.O_RDONLY);
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw error;
  }
}

export interface LeaseRecord {
  token: string;
  pid: number;
  identity: string;
  mode: "runtime" | "setup_auth" | "re_auth";
  heartbeat: number;
  createdAt: number;
}
function staleMs(): number {
  const configured = Number(process.env.NOTEBOOK_LEASE_STALE_MS);
  return Number.isFinite(configured) && configured >= 50 ? configured : 30_000;
}
async function selfIdentity(): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([
        fsp.readFile(`/proc/${process.pid}/stat`, "utf8"),
        fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return `linux:${boot.trim()}:${fields[19]}`; // field 22, after pid/comm
    }
    if (process.platform === "darwin") {
      const [{ stdout: lstart }, { stdout: boot }] = await Promise.all([
        execFileAsync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
          env: { ...process.env, LC_ALL: "C" },
        }),
        execFileAsync("sysctl", ["-n", "kern.boottime"]),
      ]);
      return `darwin:${boot.trim()}:${lstart.trim()}`;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').CreationDate + '|' + (Get-CimInstance Win32_OperatingSystem).LastBootUpTime`,
      ]);
      return `win32:${stdout.trim()}`;
    }
  } catch {
    /* fail closed */
  }
  return null;
}
async function pidIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([
        fsp.readFile(`/proc/${pid}/stat`, "utf8"),
        fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return `linux:${boot.trim()}:${fields[19]}`;
    }
    if (process.platform === "darwin") {
      const [{ stdout: lstart }, { stdout: boot }] = await Promise.all([
        execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
          env: { ...process.env, LC_ALL: "C" },
        }),
        execFileAsync("sysctl", ["-n", "kern.boottime"]),
      ]);
      return lstart.trim() ? `darwin:${boot.trim()}:${lstart.trim()}` : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate + '|' + (Get-CimInstance Win32_OperatingSystem).LastBootUpTime`,
      ]);
      return stdout.trim() ? `win32:${stdout.trim()}` : null;
    }
  } catch {
    /* unavailable => never steal */
  }
  return null;
}

async function ownerStatus(record: LeaseRecord): Promise<"dead" | "same" | "reused" | "ambiguous"> {
  // Staleness is mandatory: an identity mismatch alone is not permission to
  // take an actively heartbeating lease.
  if (!Number.isFinite(record.heartbeat) || Date.now() - record.heartbeat < staleMs())
    return "ambiguous";
  const identity = await pidIdentity(record.pid);
  if (identity) return identity === record.identity ? "same" : "reused";
  try {
    process.kill(record.pid, 0);
    return "ambiguous"; // live but the platform identity probe was unavailable
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "ambiguous";
  }
}

export class BaseProfileLeaseHandle {
  private released = false;
  private releasePromise?: Promise<void>;
  private lossPromise?: Promise<void>;
  private lossListeners = new Set<() => void | Promise<void>>();
  readonly generation: string;
  constructor(
    private readonly owner: BaseProfileLease,
    readonly token: string,
    generation: string,
    private mode: LeaseRecord["mode"]
  ) {
    this.generation = generation;
  }
  async heartbeat(): Promise<boolean> {
    const ok = !this.released && (await this.owner.heartbeat(this));
    if (!ok && !this.released) {
      this.lossPromise ??= Promise.allSettled(
        [...this.lossListeners].map((listener) => Promise.resolve().then(listener))
      ).then(() => undefined);
      await this.lossPromise;
    }
    return ok;
  }
  release(): Promise<void> {
    if (!this.releasePromise) {
      this.released = true;
      this.releasePromise = this.owner.release(this);
    }
    return this.releasePromise;
  }
  async setMode(mode: LeaseRecord["mode"]): Promise<boolean> {
    if (this.released) return false;
    this.mode = mode;
    return this.owner.retag(this, mode);
  }
  get currentMode(): LeaseRecord["mode"] {
    return this.mode;
  }
  get isReleased(): boolean {
    return this.released;
  }
  onLost(listener: () => void | Promise<void>): void {
    this.lossListeners.add(listener);
  }
}

export class BaseProfileLease {
  private record?: LeaseRecord;
  private timer?: NodeJS.Timeout;
  private operationTail: Promise<void> = Promise.resolve();
  constructor(private readonly dir: string) {}
  private get file(): string {
    return path.join(this.dir, "base-profile.lease.json");
  }
  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async acquire(mode: LeaseRecord["mode"]): Promise<BaseProfileLeaseHandle | null> {
    if (this.record) return null;
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dir, 0o700);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.dir, {
        stale: Math.max(2_000, staleMs()),
        update: Math.max(1_000, Math.floor(staleMs() / 2)),
        retries: 0,
        onCompromised: () => {
          this.record = undefined;
          if (this.timer) clearInterval(this.timer);
          this.timer = undefined;
        },
      });
      return await this.acquireLocked(mode);
    } catch {
      return null;
    } finally {
      await release?.().catch(() => undefined);
    }
  }
  private async acquireLocked(mode: LeaseRecord["mode"]): Promise<BaseProfileLeaseHandle | null> {
    // Reentrancy is unsafe: setup/re_auth must not silently borrow and later
    // release a runtime owner. A handle is the only ownership capability.
    if (this.record) return null;
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dir, 0o700);
    const identity = await selfIdentity();
    if (!identity) return null;
    const record: LeaseRecord = {
      token: randomBytes(24).toString("hex"),
      pid: process.pid,
      identity,
      mode,
      heartbeat: Date.now(),
      createdAt: Date.now(),
    };
    try {
      const h = await fsp.open(
        this.file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600
      );
      try {
        await h.writeFile(JSON.stringify(record));
        await h.sync();
      } finally {
        await h.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      let previous: LeaseRecord;
      let before: fs.Stats;
      try {
        before = await fsp.lstat(this.file);
        previous = (await readSecureJson(this.file, 16 * 1024)) as LeaseRecord;
      } catch {
        return null;
      }
      const status = await ownerStatus(previous);
      if (status !== "dead" && status !== "reused") return null;
      try {
        // Re-read metadata and token immediately before an atomic quarantine
        // rename. Never blindly unlink a lease path that may have changed.
        const again = (await readSecureJson(this.file, 16 * 1024)) as LeaseRecord;
        const after = await fsp.lstat(this.file);
        if (again.token !== previous.token || after.ino !== before.ino || after.dev !== before.dev)
          return null;
        const quarantine = `${this.file}.stale.${previous.token}.${randomBytes(6).toString("hex")}`;
        await fsp.rename(this.file, quarantine);
        const moved = (await readSecureJson(quarantine, 16 * 1024)) as LeaseRecord;
        if (moved.token !== previous.token) return null;
        await fsp.unlink(quarantine);
      } catch {
        return null;
      }
      return this.acquireLocked(mode);
    }
    this.record = record;
    const handle = new BaseProfileLeaseHandle(
      this,
      record.token,
      randomBytes(12).toString("hex"),
      mode
    );
    this.timer = setInterval(() => void handle.heartbeat(), 5_000);
    this.timer.unref();
    return handle;
  }
  async heartbeat(handle: BaseProfileLeaseHandle): Promise<boolean> {
    return this.serialized(async () => {
      if (!this.record || this.record.token !== handle.token) return false;
      try {
        const current = (await readSecureJson(this.file, 16 * 1024)) as LeaseRecord;
        if (current.token !== handle.token || !this.record || this.record.token !== handle.token)
          return false;
        this.record = { ...current, heartbeat: Date.now(), mode: handle.currentMode };
        await writeSecureJson(this.file, this.record);
        return true;
      } catch {
        return false;
      }
    });
  }
  async owns(handle: BaseProfileLeaseHandle, allowedMode?: LeaseRecord["mode"]): Promise<boolean> {
    if (handle.isReleased || !this.record || this.record.token !== handle.token) return false;
    if (allowedMode && handle.currentMode !== allowedMode) return false;
    try {
      const current = (await readSecureJson(this.file, 16 * 1024)) as LeaseRecord;
      return current.token === handle.token && current.mode === handle.currentMode;
    } catch {
      return false;
    }
  }
  async retag(handle: BaseProfileLeaseHandle, mode: LeaseRecord["mode"]): Promise<boolean> {
    if (!this.record || this.record.token !== handle.token) return false;
    this.record.mode = mode;
    return this.heartbeat(handle);
  }
  async release(handle: BaseProfileLeaseHandle): Promise<void> {
    await this.serialized(async () => {
      if (!this.record || this.record.token !== handle.token) return;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      const record = this.record;
      this.record = undefined;
      try {
        const before = await fsp.lstat(this.file);
        const current = (await readSecureJson(this.file, 16 * 1024)) as LeaseRecord;
        const after = await fsp.lstat(this.file);
        if (
          current.token === record.token &&
          before.ino === after.ino &&
          before.dev === after.dev
        ) {
          const retired = `${this.file}.released.${record.token}.${randomBytes(6).toString("hex")}`;
          await fsp.rename(this.file, retired);
          await fsp.unlink(retired);
          const dh = await fsp.open(this.dir, fs.constants.O_RDONLY);
          try {
            await dh.sync();
          } finally {
            await dh.close();
          }
        }
      } catch {
        /* token mismatch or lost lease: never unlink */
      }
    });
  }
}

export async function inspectSnapshotFile(file: string): Promise<SnapshotInspection> {
  try {
    return inspectStorageState(await readSecureJson(file));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      usable: false,
      bootstrapEligible: false,
      evidence: code === "ENOENT" ? "none" : "invalid",
      criticalPersistent: 0,
      criticalSessionOnly: 0,
      invalidCritical: 0,
      reason: code === "ENOENT" ? "snapshot_missing" : "snapshot_malformed_or_unsafe",
    };
  }
}
