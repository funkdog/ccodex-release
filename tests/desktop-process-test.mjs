import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import {
  desktopEndpointOwner, desktopProcessMatches, readProcessIdentity,
  sameProcessLifetime, windowsArguments,
} from "../bridge/desktop-process.mjs";

const pid = 1234;
const port = 22691;
const boot = "01234567-0123-0123-0123-0123456789ab";
const start = ticks => `${pid} (a name with ) parentheses) S ` +
  `${Array(18).fill("0").join(" ")} ${ticks} 0 0\n`;
const args = [
  "/private/vendor/chatgpt", "--user-data-dir=/private/profile/desktop-data",
  `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
];
const identity = {
  pid, platform: "linux", lifetime: `linux:${boot}:987654321`,
  executable: args[0], args,
};
const expected = { executable: args[0], userData: "/private/profile/desktop-data", port };

test("Windows command inspection preserves spaces, Unicode, quotes and trailing slashes", () => {
  assert.deepEqual(windowsArguments(
    '"C:\\Program Files\\ChatGPT.exe" "--user-data-dir=C:\\测试 用户\\desktop-data" --remote-debugging-port=22691'),
  ["C:\\Program Files\\ChatGPT.exe", "--user-data-dir=C:\\测试 用户\\desktop-data", "--remote-debugging-port=22691"]);
  assert.deepEqual(windowsArguments('one\\ two "" "a""b"'), ["one\\", "two", "", 'a"b']);
  assert.throws(() => windowsArguments('"unclosed'), /Unclosed/);
});

test("Windows process identity keeps creation ticks as a string, never a rounded number", () => {
  const record = {
    pid, lifetime: "windows:639000000012345678", executable: "C:\\private\\ChatGPT.exe",
    commandLine: '"C:\\private\\ChatGPT.exe" --user-data-dir=C:\\private\\data --remote-debugging-port=22691',
  };
  const result = readProcessIdentity(pid, {
    platform: "win32", invoke: () => ({ status: 0, stdout: JSON.stringify(record) }),
  });
  assert.equal(result.lifetime, record.lifetime);
  assert.equal(result.args[1], "--user-data-dir=C:\\private\\data");
});

test("Windows process identity distinguishes a dead process from unreadable live identity", () => {
  assert.equal(readProcessIdentity(pid, {
    platform: "win32", invoke: () => ({ status: 0, stdout: "null" }),
  }), null);
  assert.throws(() => readProcessIdentity(pid, {
    platform: "win32", invoke: () => ({ status: 1, stdout: "" }),
  }), /could not be established/);
});

test("Linux process identity binds boot id, start ticks, executable and NUL-delimited argv", () => {
  const result = readProcessIdentity(pid, {
    platform: "linux", procRoot: "/fixture",
    readFile: file => file.endsWith("/stat") ? start("987654321")
      : file.endsWith("/boot_id") ? boot : `${args.join("\0")}\0`,
    readLink: () => args[0],
  });
  assert.deepEqual(result, identity);
});

test("Linux identity rejects a PID that changes during inspection", () => {
  let stats = 0;
  assert.throws(() => readProcessIdentity(pid, {
    platform: "linux", procRoot: "/fixture",
    readFile: file => file.endsWith("/stat") ? start(String(++stats))
      : file.endsWith("/boot_id") ? boot : `${args.join("\0")}\0`,
    readLink: () => args[0],
  }), /changed during/);
});

test("process lifetime comparison rejects PID reuse, executable changes and missing birth evidence", () => {
  assert.equal(sameProcessLifetime(identity, { ...identity }), true);
  assert.equal(sameProcessLifetime(identity, { ...identity, lifetime: "linux:new-boot:1" }), false);
  assert.equal(sameProcessLifetime(identity, { ...identity, executable: "/stock/chatgpt" }), false);
  assert.equal(sameProcessLifetime({ ...identity, lifetime: undefined },
    { ...identity, lifetime: undefined }), false);
});

test("Desktop process matching requires the private executable and exact unique data/port flags", () => {
  assert.equal(desktopProcessMatches(identity, expected), true);
  assert.equal(desktopProcessMatches({ ...identity, executable: "/stock/chatgpt" }, expected), false);
  assert.equal(desktopProcessMatches({ ...identity, args: [...args, "--user-data-dir=/stock"] }, expected), false);
  assert.equal(desktopProcessMatches({ ...identity, args: args.filter(arg => !arg.startsWith("--user-data-dir")) },
    expected), false);
  assert.equal(desktopProcessMatches({ ...identity, args: args.map(arg =>
    arg.startsWith("--remote-debugging-port") ? "--remote-debugging-port=9222" : arg) }, expected), false);
});

test("Linux endpoint ownership joins exact IPv4 loopback listen inode to the expected process fd", () => {
  const tcp = "header\n" +
    `0: 0100007F:${port.toString(16).toUpperCase()} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 45678 1\n`;
  assert.equal(desktopEndpointOwner(port, {
    platform: "linux", pid, procRoot: "/fixture",
    readFile: () => tcp, readDirectory: () => ["3"], readLink: () => "socket:[45678]",
  }), pid);
  assert.throws(() => desktopEndpointOwner(port, {
    platform: "linux", pid, procRoot: "/fixture",
    readFile: () => tcp, readDirectory: () => ["3"], readLink: () => "socket:[99999]",
  }), /does not own/);
  assert.throws(() => desktopEndpointOwner(port, {
    platform: "linux", pid, procRoot: "/fixture",
    readFile: () => tcp.replace("0100007F", "00000000"),
    readDirectory: () => ["3"], readLink: () => "socket:[45678]",
  }), /does not own/);
});

test("Windows endpoint ownership rejects ambiguous listeners instead of taking the first PID", () => {
  assert.equal(desktopEndpointOwner(port, {
    platform: "win32", invoke: () => ({ status: 0,
      stdout: `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}\r\n` }),
  }), pid);
  assert.throws(() => desktopEndpointOwner(port, {
    platform: "win32", invoke: () => ({ status: 0,
      stdout: `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    ${pid}\r\n` +
        `  TCP    127.0.0.1:${port}    0.0.0.0:0    LISTENING    5678\r\n` }),
  }), /ambiguous/);
});

test("macOS identity requires stable ps lifetime and lsof executable, not a matching process name", () => {
  const result = readProcessIdentity(pid, {
    platform: "darwin",
    invoke: (program, callArgs) => ({
      status: 0,
      stdout: program.endsWith("lsof") ? `p${pid}\nn/private/vendor/ChatGPT\n`
        : callArgs.includes("lstart=") ? "Thu Oct  1 20:59:00 2026\n"
          : "/private/vendor/ChatGPT --user-data-dir=/private/data --remote-debugging-port=22691\n",
    }),
  });
  assert.equal(result.executable, "/private/vendor/ChatGPT");
  assert.equal(result.lifetime, "macos:Thu Oct 1 20:59:00 2026");
});

test("macOS identity tolerates an exit between lifetime and executable inspection", () => {
  let births = 0;
  assert.equal(readProcessIdentity(pid, {
    platform: "darwin", invoke: (program, callArgs) => callArgs.includes("lstart=") && ++births === 1
      ? { status: 0, stdout: "Thu Oct  1 20:59:00 2026\n" }
      : { status: 1, stdout: "" },
  }), null);
});

test("macOS identity treats an unreaped zombie as exited but rejects unreadable live processes", () => {
  for (const state of ["Z", "Z+", "S", "R"]) {
    const probe = () => readProcessIdentity(pid, {
      platform: "darwin", invoke: (program, callArgs) => callArgs.includes("lstart=")
        ? { status: 0, stdout: "Thu Oct  1 20:59:00 2026\n" }
        : callArgs.includes("stat=") ? { status: 0, stdout: `${state}\n` }
          : { status: 1, stdout: "" },
    });
    if (state.startsWith("Z")) assert.equal(probe(), null);
    else assert.throws(probe, /could not be established/);
  }
});

test("macOS flattened argv is bound to the complete recorded invocation, not decoy substrings", () => {
  const launchArgs = ["--user-data-dir=/private/profile/desktop-data", `--remote-debugging-port=${port}`];
  const mac = { ...identity, platform: "darwin", args: undefined,
    commandLine: [args[0], ...launchArgs].join(" ") };
  assert.equal(desktopProcessMatches(mac, { ...expected, launchArgs }), true);
  assert.equal(desktopProcessMatches({ ...mac, commandLine: `${args[0]} --decoy=${launchArgs.join(" ")}` },
    { ...expected, launchArgs }), false);
});

test("macOS endpoint ownership rejects public/all-address listeners and other owners", () => {
  const invoke = stdout => () => ({ status: 0, stdout });
  assert.equal(desktopEndpointOwner(port, {
    platform: "darwin", pid, invoke: invoke(`p${pid}\nn127.0.0.1:${port}\n`),
  }), pid);
  assert.throws(() => desktopEndpointOwner(port, {
    platform: "darwin", pid, invoke: invoke(`p${pid}\nn*:${port}\n`),
  }), /does not own/);
  assert.throws(() => desktopEndpointOwner(port, {
    platform: "darwin", pid, invoke: invoke(`p9999\nn127.0.0.1:${port}\n`),
  }), /does not own/);
});

test("real current-process lifetime inspection works without modifying any application", () => {
  const first = readProcessIdentity(process.pid);
  const second = readProcessIdentity(process.pid);
  assert.equal(first.pid, process.pid);
  assert.equal(sameProcessLifetime(first, second), true);
});

test("real loopback listener ownership belongs to the exact current process", async t => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal(desktopEndpointOwner(port, { pid: process.pid }), process.pid);
});
