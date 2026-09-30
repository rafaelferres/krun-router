import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * On Windows, POSIX modes are ignored. The standard-library option is the built-in `icacls`:
 * drop inherited entries and grant only the current user. Best effort; a failure leaves the
 * file with the user profile's default ACL, which is already per-user.
 */
export function restrictWindowsAcl(path, env = process.env) {
  if (process.platform !== "win32" || !env.USERNAME) return false;
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  try {
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a file only the current user can read: directory 0700, file 0600 (POSIX), owner-only
 * ACL (Windows). Written to a temp file first and renamed, so a crash never leaves a partial file.
 */
export function writePrivateFile(file, text) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
  else restrictWindowsAcl(file);
}

/**
 * Masked form for display: `krun_live_••••••••Fk2`. Never the full value; short or unknown
 * keys show only mask characters and the last three when the key is long enough to afford it.
 */
export function maskKey(key) {
  if (!key) return "not set";
  const m = /^(krun_(?:live|test)_)(.+)$/.exec(key);
  if (m && m[2].length >= 8) return `${m[1]}••••••••${m[2].slice(-3)}`;
  if (key.length >= 16) return `••••••••${key.slice(-3)}`;
  return "••••••••";
}
