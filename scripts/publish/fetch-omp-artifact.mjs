#!/usr/bin/env node
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { stageOmpArtifact, verifyOmpArtifact } from "../omp-artifact.mjs";

const help = `Usage: node scripts/publish/fetch-omp-artifact.mjs check
       node scripts/publish/fetch-omp-artifact.mjs download <win32-x64|linux-x64> <destination>
Required: OMP_ARTIFACT_REPOSITORY (owner/repo), OMP_ARTIFACT_RUN_ID,
OMP_ARTIFACT_COMMIT (full SHA), OMP_ARTIFACT_TOKEN (Actions read access).
Downloads only the named artifact from the pinned successful run. Writes
ZCODE_OMP_ARTIFACT_ROOT to GITHUB_ENV after manifest/release verification.
`;

function configuration(env) {
  const required = [
    "OMP_ARTIFACT_REPOSITORY",
    "OMP_ARTIFACT_RUN_ID",
    "OMP_ARTIFACT_COMMIT",
    "OMP_ARTIFACT_TOKEN",
  ];
  for (const key of required) if (!env[key]?.trim()) throw new Error(`Missing required ${key}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.OMP_ARTIFACT_REPOSITORY))
    throw new Error("Invalid OMP_ARTIFACT_REPOSITORY");
  if (!/^[1-9]\d*$/.test(env.OMP_ARTIFACT_RUN_ID)) throw new Error("Invalid OMP_ARTIFACT_RUN_ID");
  if (!/^[a-f0-9]{40}$/.test(env.OMP_ARTIFACT_COMMIT))
    throw new Error("OMP_ARTIFACT_COMMIT must be a full lowercase source SHA");
  return {
    repository: env.OMP_ARTIFACT_REPOSITORY,
    run: env.OMP_ARTIFACT_RUN_ID,
    expectedSHA: env.OMP_ARTIFACT_COMMIT,
    token: env.OMP_ARTIFACT_TOKEN,
  };
}

async function api(config, suffix, accept = "application/vnd.github+json", redirect = "follow") {
  const response = await fetch(`https://api.github.com/repos/${config.repository}${suffix}`, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect,
  });
  if (!response.ok && response.status !== 302)
    throw new Error(`OMP artifact API request failed (HTTP ${response.status})`);
  return response;
}

export async function checkOmpRun(env = process.env) {
  const config = configuration(env);
  const run = await (await api(config, `/actions/runs/${config.run}`)).json();
  if (
    String(run.id) !== config.run ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_sha !== config.expectedSHA ||
    run.repository?.full_name?.toLowerCase() !== config.repository.toLowerCase()
  ) {
    throw new Error(
      "OMP producer run must be completed/successful and match the configured repository and source SHA",
    );
  }
  return config;
}

async function findArtifact(config, target) {
  const matches = [];
  for (let page = 1; ; page++) {
    const result = await (
      await api(config, `/actions/runs/${config.run}/artifacts?per_page=100&page=${page}`)
    ).json();
    if (!Array.isArray(result.artifacts)) throw new Error("Invalid OMP producer artifact listing");
    matches.push(...result.artifacts.filter((item) => item.name === `omp-zcode-${target}`));
    if (result.artifacts.length < 100) break;
  }
  if (matches.length !== 1 || matches[0].expired)
    throw new Error(`Expected one unexpired omp-zcode-${target} artifact in the pinned run`);
  const artifact = matches[0];
  if (
    artifact.workflow_run &&
    (String(artifact.workflow_run.id) !== config.run ||
      artifact.workflow_run.head_sha !== config.expectedSHA)
  )
    throw new Error("OMP artifact run provenance mismatch");
  return artifact;
}

async function extract(zipPath, destination) {
  // Lazy dependency resolution keeps import and --help safe before installation.
  const require = createRequire(new URL("../../packages/desktop/package.json", import.meta.url));
  const yauzl = require("yauzl");
  const zip = await new Promise((accept, reject) =>
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true }, (error, value) =>
      error ? reject(error) : accept(value),
    ),
  );
  await new Promise((accept, reject) => {
    zip.on("error", reject);
    zip.on("end", accept);
    zip.on("entry", (entry) => {
      (async () => {
        const name = entry.fileName;
        if (
          !name ||
          name.includes("\\") ||
          name.startsWith("/") ||
          /^[A-Za-z]:/.test(name) ||
          name.split("/").some((part) => part === "..")
        )
          throw new Error("Unsafe OMP archive path");
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000))
          throw new Error("OMP archive contains a link or special file");
        const output = resolve(destination, name);
        if (name.endsWith("/")) await mkdir(output, { recursive: true });
        else {
          await mkdir(dirname(output), { recursive: true });
          const stream = await new Promise((yes, no) =>
            zip.openReadStream(entry, (error, value) => (error ? no(error) : yes(value))),
          );
          await pipeline(stream, createWriteStream(output, { flags: "wx" }));
        }
        zip.readEntry();
      })().catch((error) => {
        zip.close();
        reject(error);
      });
    });
    zip.readEntry();
  });
}

export async function downloadOmpArtifact(target, destination, env = process.env) {
  if (!["win32-x64", "linux-x64"].includes(target))
    throw new Error("Unsupported OMP artifact target");
  const config = await checkOmpRun(env);
  const artifact = await findArtifact(config, target);
  const temporary = await mkdtemp(resolve(tmpdir(), "omp-artifact-"));
  const root = resolve(destination);
  if (/[\r\n]/.test(root)) throw new Error("OMP destination contains a newline");
  try {
    let response = await api(
      config,
      `/actions/artifacts/${artifact.id}/zip`,
      "application/zip",
      "manual",
    );
    if (response.status === 302) {
      const location = new URL(response.headers.get("location"));
      if (location.protocol !== "https:") throw new Error("OMP artifact redirect must use HTTPS");
      // Never forward the producer credential to the signed blob URL.
      response = await fetch(location);
    }
    if (!response.ok || !response.body)
      throw new Error(`OMP artifact download failed (HTTP ${response.status})`);
    const archive = resolve(temporary, "payload.zip");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    if (artifact.digest) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(archive)) hash.update(chunk);
      if (artifact.digest !== `sha256:${hash.digest("hex")}`)
        throw new Error("OMP Actions artifact digest mismatch");
    }
    const extracted = resolve(temporary, "extracted");
    await mkdir(extracted);
    await extract(archive, extracted);
    const { manifest } = await verifyOmpArtifact(resolve(extracted, target), target);
    const pin = JSON.parse(await readFile(resolve(extracted, "omp-release.json"), "utf8"));
    if (manifest.commit !== config.expectedSHA || pin.commit !== config.expectedSHA)
      throw new Error("OMP manifest source commit does not match expectedSHA");
    await stageOmpArtifact({ sourceRoot: extracted, destination: resolve(root, target), target });
    await copyFile(resolve(extracted, "omp-release.json"), resolve(root, "omp-release.json"));
    if (env.GITHUB_ENV) await appendFile(env.GITHUB_ENV, `ZCODE_OMP_ARTIFACT_ROOT=${root}\n`);
    if (env.GITHUB_STEP_SUMMARY)
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `OMP ${target}: ${manifest.version}, source ${manifest.commit}, producer run ${config.run}; ZCode ${env.GITHUB_SHA || "local"}.\n`,
      );
    return root;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(help);
    return;
  }
  if (args.length === 1 && args[0] === "check") {
    await checkOmpRun();
    return;
  }
  if (args.length === 3 && args[0] === "download") {
    console.log(await downloadOmpArtifact(args[1], args[2]));
    return;
  }
  throw new Error(help);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
