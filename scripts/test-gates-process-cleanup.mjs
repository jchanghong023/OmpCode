import { spawn, execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const normalize = (value) => {
  const path = value.replaceAll("\\", "/").replace(/\/$/u, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
};
const argumentsOf = (command) =>
  (command.match(/(?:[^\s"]+|"[^"]*")+/gu) ?? []).map((part) => part.replaceAll('"', ""));

async function processes(powershell, pids) {
  if (process.platform === "win32") {
    // 原因：全机 Win32_Process 枚举需序列化数百进程的完整命令行，本机高负载下单次可达数秒；
    // 复核扫描只需已选中 PID 的最新行，按 PID 过滤把结果集缩到个位数，语义（身份复核、
    // server 识别、PID 复用防护）不变。首次拓扑发现仍需一次全量枚举。
    const filter = pids?.length
      ? ` -Filter '${[...new Set(pids)].map((pid) => `ProcessId=${pid}`).join(" OR ")}'`
      : "";
    const { stdout } = await execute(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process" +
          filter +
          " | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine) | ConvertTo-Json -Compress",
      ],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const rows = JSON.parse(stdout || "[]");
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
      pid: row.ProcessId,
      parent: row.ParentProcessId,
      identity: row.CreationDate,
      name: row.Name,
      args: argumentsOf(row.CommandLine ?? ""),
    }));
  }
  if (process.platform === "linux") {
    const rows = await Promise.all(
      (await readdir("/proc"))
        .filter((name) => /^\d+$/u.test(name))
        .map(async (name) => {
          try {
            const [stat, command] = await Promise.all([
              readFile(`/proc/${name}/stat`, "utf8"),
              readFile(`/proc/${name}/cmdline`, "utf8"),
            ]);
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            const args = command.split("\0").filter(Boolean);
            return {
              pid: Number(name),
              parent: Number(fields[1]),
              identity: fields[19],
              name: args[0] ?? "",
              args,
            };
          } catch (error) {
            if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
          }
        }),
    );
    return rows.filter(Boolean);
  }
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,lstart=,args="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/u);
      if (!match) throw new Error("Cannot inspect gate process ancestry");
      const args = argumentsOf(match[4]);
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        identity: match[3],
        name: args[0] ?? "",
        args,
      };
    });
}

const outputBaseOf = (row) =>
  row.args.find((arg) => arg.startsWith("--output_base="))?.slice("--output_base=".length);
const isServer = (row) => {
  const jar = row.args.indexOf("-jar");
  return (
    /(?:^|[/\\])javaw?(?:\.exe)?$/iu.test(row.name) &&
    jar >= 0 &&
    /(?:^|[/\\])A-server\.jar$/iu.test(row.args[jar + 1] ?? "")
  );
};
const isUninspectableJava = (row) => !row.args.length && /^(?:java|javaw)\.exe$/iu.test(row.name);

async function cleanup({ roots, supervisorPid, powershell, bazelAdmissions = [] }) {
  const rows = await processes(powershell);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const rootPids = new Set(roots.map((root) => root.pid));
  if (supervisorPid) rootPids.add(supervisorPid);
  const descendsFrom = (row, ancestors) => {
    const visited = new Set();
    for (
      let current = row;
      current && !visited.has(current.pid);
      current = byPid.get(current.parent)
    ) {
      if (ancestors.has(current.pid)) return true;
      visited.add(current.pid);
    }
    return false;
  };
  const servers = rows.filter(isServer);
  const protectedPids = new Set(servers.map((row) => row.pid));
  for (const row of rows) if (isUninspectableJava(row)) protectedPids.add(row.pid);
  const nearestServer = (row) => {
    const visited = new Set();
    for (
      let current = row;
      current && !visited.has(current.pid);
      current = byPid.get(current.parent)
    ) {
      if (protectedPids.has(current.pid)) return current.pid;
      visited.add(current.pid);
    }
  };
  // 新 server 在 PID 文件落盘前仍可能是客户端后代；禁止对启动祖先使用 /T 或进程组 kill。
  // 软清理和 watchdog 清理可重叠；不能互杀仍在收口 worker 的脱离清理器。
  const cleanupPids = new Set(
    rows
      .filter((row) => normalize(row.args[1] ?? "") === normalize(fileURLToPath(import.meta.url)))
      .map((row) => row.pid),
  );
  cleanupPids.add(process.pid);
  const owned = rows.filter(
    (row) =>
      descendsFrom(row, rootPids) &&
      !descendsFrom(row, protectedPids) &&
      !descendsFrom(row, cleanupPids),
  );
  const ownedPids = new Set(owned.map((row) => row.pid));
  const bases = new Set();
  for (const root of roots) {
    const row = byPid.get(root.pid);
    if (row && ownedPids.has(row.pid) && root.outputBase) bases.add(normalize(root.outputBase));
  }
  // 只认显式 Bazel 准入且参数逐项相同的活跃客户端；提及 output_base 的 Node 哨兵不是调用。
  for (const admission of bazelAdmissions) {
    for (const row of owned) {
      const tail = row.args.slice(-admission.args.length);
      if (
        tail.length === admission.args.length &&
        tail.every((arg, index) => arg === admission.args[index]) &&
        normalize(row.args[0] ?? "").toLowerCase() === normalize(admission.command).toLowerCase()
      )
        bases.add(normalize(admission.outputBase));
    }
  }
  const nativeServers = new Set(
    servers
      .filter((row) => {
        const base = outputBaseOf(row);
        return base && bases.has(normalize(base));
      })
      .map((row) => row.pid),
  );
  const workerRoots = new Set();
  for (const row of rows) {
    if (!nativeServers.has(nearestServer(row)) || protectedPids.has(row.pid)) continue;
    const stage = row.args.indexOf("--stage");
    const executor = row.args.some((arg) =>
      /(?:^|[/\\])test-gates-(?:action|bazel-exec)\.mjs$/u.test(arg),
    );
    const launcher = row.args.some((arg) => {
      const path = normalize(arg);
      return (
        (path.startsWith("bazel-out/") ||
          [...bases].some((base) => path.startsWith(`${base}/execroot/`))) &&
        /\/(?:gate-[^/]+|_gate_runner)(?:\.exe)?$/u.test(path)
      );
    });
    if ((executor && stage >= 0 && row.args[stage + 1]?.startsWith("gate-")) || launcher)
      workerRoots.add(row.pid);
  }
  const workers = rows.filter((row) => {
    if (descendsFrom(row, cleanupPids)) return false;
    const visited = new Set();
    for (
      let current = row;
      current && !visited.has(current.pid);
      current = byPid.get(current.parent)
    ) {
      if (protectedPids.has(current.pid)) return false;
      if (workerRoots.has(current.pid)) return true;
      visited.add(current.pid);
    }
    return false;
  });
  const selected = new Map([...owned, ...workers].map((row) => [row.pid, row]));
  selected.delete(supervisorPid);
  const workerPids = new Set(workers.map((row) => row.pid));
  // 先清理已核对的本轮动作，再关闭客户端；不能在客户端释放 output_base 后重扫并误收下一轮。
  const ordered = [...selected.values()].sort((a, b) => {
    if (a.pid === b.pid) return 0;
    const workerOrder = Number(workerPids.has(b.pid)) - Number(workerPids.has(a.pid));
    if (workerOrder) return workerOrder;
    if (descendsFrom(a, new Set([b.pid]))) return -1;
    if (descendsFrom(b, new Set([a.pid]))) return 1;
    return 0;
  });
  // 复核只需已排序候选（含 supervisor）的最新行；无候选时跳过扫描，不再全机枚举。
  const candidates = ordered.map((row) => row.pid);
  if (supervisorPid) candidates.push(supervisorPid);
  const current = new Map(
    (candidates.length ? await processes(powershell, candidates) : []).map((row) => [row.pid, row]),
  );
  for (const row of ordered) {
    const latest = current.get(row.pid);
    if (!latest || latest.identity !== row.identity || isServer(latest)) continue;
    try {
      process.kill(row.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if (supervisorPid) {
    const original = byPid.get(supervisorPid);
    if (original && current.get(supervisorPid)?.identity === original.identity)
      process.kill(supervisorPid, "SIGKILL");
  }
}

export function cleanupOwnedProcesses(
  roots,
  { supervisorPid, powershell, detached = false, bazelAdmissions = [] } = {},
) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      JSON.stringify({ roots, supervisorPid, powershell, bazelAdmissions }),
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: detached ? "ignore" : ["ignore", "ignore", "pipe"],
    },
  );
  if (detached) {
    child.on("error", () => {
      if (supervisorPid) process.kill(supervisorPid, "SIGKILL");
    });
    child.unref();
    return;
  }
  return new Promise((done, reject) => {
    let errorText = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errorText += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) done();
      else reject(new Error(`Gate worker cleanup failed (${code ?? signal}): ${errorText.trim()}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(process.argv[2]);
  try {
    await cleanup(request);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    // 清理失败也不能把独立硬截止变成无限等待；只终止监督者自身，绝不扩大到 server 树。
    if (request.supervisorPid) {
      try {
        process.kill(request.supervisorPid, "SIGKILL");
      } catch (failure) {
        if (failure.code !== "ESRCH") console.error(failure);
      }
    }
  }
}
