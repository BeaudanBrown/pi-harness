"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
// Substituted at packaging. The override is for isolated integration tests.
const addon = () => require(process.env.PI_NATIVE_LOCK_ADDON || "@nativeLockAddon@");
const held = new Map();

function canonical(file) {
  const resolved = path.resolve(file);
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.nlink !== 1) throw Error("native session must be a regular file, not a hard link");
    return real;
  }
  return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
}
function lockDirectory() {
  // Host-local, even when native history is synchronized. Never use the session
  // directory, a synchronized agent config, or a PID/lock-file existence test.
  const directory = process.env.PI_SESSION_LOCK_DIRECTORY || path.join(os.homedir(), ".cache", "pi-session-locks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw Error("native session lock directory must be private and owned by this user");
  }
  return directory;
}
function lockPath(file) {
  return path.join(lockDirectory(), createHash("sha256").update(canonical(file)).digest("hex") + ".lock");
}
function acquireSessionLock(file) {
  const key = canonical(file);
  let record = held.get(key);
  if (!record) {
    const fd = fs.openSync(lockPath(key), fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw Error("unsafe native session lock file");
      if (!addon().lock(fd)) throw Error("Native Pi session is already open; focus its existing terminal or close it before resuming.");
      // Advisory display only. Existence/content NEVER authorizes a launch/kill.
      fs.ftruncateSync(fd, 0);
      const serverPid = Number((process.env.TMUX || "").split(",").at(-2)) || null;
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, pane: process.env.TMUX_PANE || null, serverPid, file: key }));
      record = { fd, count: 0 };
      held.set(key, record);
    } catch (error) { fs.closeSync(fd); throw error; }
  }
  record.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--record.count === 0) {
      fs.closeSync(record.fd);
      held.delete(key);
      // Do not unlink: another process may already have opened this inode.
    }
  };
}

function tryTaskLock(common, purpose) {
  if (purpose !== "setup" && purpose !== "git") throw Error("unknown task lock purpose");
  const file = path.join(lockDirectory(), "task-" + purpose + "-" + createHash("sha256").update(common).digest("hex") + ".lock");
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw Error("unsafe task setup lock");
    if (!addon().lock(fd)) { fs.closeSync(fd); return undefined; }
  } catch (error) { fs.closeSync(fd); throw error; }
  // Unlike native SessionManager references, separate task calls in this same
  // process must exclude each other. No PID hint, ownership file or reservation.
  let released = false;
  return { fd, release: () => { if (!released) { released = true; fs.closeSync(fd); } } };
}
const renameNoReplace = (source, target) => addon().renameNoReplace(source, target);
module.exports = { acquireSessionLock, canonical, lockPath, renameNoReplace, tryTaskLock };
