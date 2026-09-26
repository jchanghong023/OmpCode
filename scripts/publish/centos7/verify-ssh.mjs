import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const [packageRoot] = process.argv.slice(2);
if (!packageRoot) throw new Error("Usage: node verify-ssh.mjs <CentOS 7 ZIP staging root>");

const desktopRoot = resolve(import.meta.dirname, "../../../packages/desktop");
const { Server } = createRequire(join(desktopRoot, "package.json"))("ssh2");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client
    .on("authentication", (context) => {
      if (
        context.method === "password" &&
        context.username === "centos7-smoke" &&
        context.password === "local-test-only"
      ) {
        context.accept();
      } else {
        context.reject();
      }
    })
    .on("ready", () => {
      client.on("session", (accept) => {
        accept().on("exec", (accept, reject, info) => {
          if (info.command !== "ssh-smoke") return reject();
          const stream = accept();
          stream.write("CENTOS7_SSH_OK");
          stream.exit(0);
          stream.end();
        });
      });
    });
});

const clientScript = `
  const { Client } = require(process.argv[1]);
  const client = new Client();
  client.on("ready", () => client.exec("ssh-smoke", (error, stream) => {
    if (error) { console.error(error.message); process.exitCode = 1; client.end(); return; }
    stream.on("data", (chunk) => process.stdout.write(chunk));
    stream.stderr.on("data", (chunk) => process.stderr.write(chunk));
    stream.on("close", (code) => { process.exitCode = code; client.end(); });
  })).on("error", (error) => { console.error(error.message); process.exitCode = 1; })
    .connect({ host: "127.0.0.1", port: Number(process.argv[2]),
      username: "centos7-smoke", password: "local-test-only", hostVerifier: () => true,
      readyTimeout: 10000 });
`;

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const root = resolve(packageRoot);
  const { stdout, stderr } = await promisify(execFile)(
    join(root, "app/zcode"),
    [
      "-e",
      clientScript,
      join(root, "app/resources/app.asar/node_modules/ssh2"),
      String(server.address().port),
    ],
    {
      timeout: 15000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        LD_LIBRARY_PATH: [join(root, "lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
      },
    },
  );
  assert.equal(stderr, "");
  assert.equal(stdout, "CENTOS7_SSH_OK");
  console.log("Packaged Electron SSH handshake OK");
} finally {
  server.close();
}
