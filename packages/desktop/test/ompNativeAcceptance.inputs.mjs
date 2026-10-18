import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function nativeInputs(workspace, configRoot) {
  const marker = "NATIVE_ACCEPTANCE";
  const paths = {
    document: join(workspace, "native-docs", "timing.md"),
    code: join(workspace, "native-code", "timing.mjs"),
    read: join(workspace, "native-read.txt"),
    attachment: join(workspace, "native-draft.txt"),
    missing: join(workspace, "directory-that-must-not-exist"),
    shared: join(configRoot, "shared-skills"),
    wiki: join(configRoot, "native-wiki"),
  };
  const values = {
    wikiIndex: "native-timing-reference-731",
    wikiQuery: "NATIVEPAGINATION731",
    wikiGrep: "NATIVE_PAGE_EVIDENCE_(?:03|19): timing slack is (?:703|719) ps\\.",
    wikiDocuments: Array.from({ length: 22 }, (_, index) => {
      const number = String(index + 1).padStart(2, "0");
      const title = `Native pagination reference ${number}`;
      return {
        path: join(workspace, "native-docs", `pagination-${number}.md`),
        title,
        content: `# ${title}\nNATIVEPAGINATION731\nNATIVE_PAGE_EVIDENCE_${number}: timing slack is ${701 + index} ps.\n`,
      };
    }),
    document: "# Native timing reference\nNATIVE_WIKI_SENTINEL_731: setup slack is 731 ps.\n",
    code: "export function nativeTiming731() { return 'NATIVE_REPO_SENTINEL_731'; }\n",
    updatedCode: "export const updatedTiming732 = 'NATIVE_REPO_UPDATED_732';\n",
    rebuiltCode: "export function rebuiltTiming733() { return 'NATIVE_REPO_REBUILT_733'; }\n",
    read: "NATIVE_REAL_READ_731\n",
    attachment: "NATIVE_ATTACHMENT_BYTES_731\n",
    draft: "NATIVE_DRAFT_KEEP_731",
    query: "nativeTiming731",
    goal: "NATIVE_GOAL_731: inspect timing, do not edit files",
    goalBudget: "37",
    loop: "NATIVE_LOOP_FINITE_731",
    stopLoop: "NATIVE_LOOP_STOP_731",
    team: "NATIVE_TEAM_731: read native-read.txt and report the exact timing evidence; do not edit any file",
  };
  const sources = [
    {
      scope: "project",
      root: join(workspace, ".omp", "skills"),
      names: ["native-project", "native-collision"],
    },
    {
      scope: "user",
      root: join(configRoot, "agent", "skills"),
      names: ["native-user", "native-collision"],
    },
    { scope: "shared", root: paths.shared, names: ["native-shared", "native-collision"] },
  ];
  const skills = sources.flatMap((source) =>
    source.names.map((name) => ({
      name,
      scope: source.scope,
      path: join(source.root, name, "SKILL.md"),
      description: `${marker} ${source.scope} ${name}`,
      sentinel: `PRIVATE_SKILL_BODY_${source.scope.toUpperCase()}_${name.replaceAll("-", "_")}_731`,
    })),
  );
  return { marker, paths, values, skills };
}

export async function prepareNativeInputs(workspace, configRoot, { paths, values, skills }) {
  for (const path of [
    workspace,
    configRoot,
    ...Object.values(paths),
    ...values.wikiDocuments.map((document) => document.path),
  ]) {
    const owned = [workspace, configRoot].some((base) => {
      const rel = relative(resolve(base), resolve(path));
      return (
        rel === "" ||
        (!rel.startsWith(`..${sep}`) && rel !== ".." && !resolve(path).startsWith(`${sep}${sep}`))
      );
    });
    assert.ok(owned, `Fixture input escaped owned roots: ${path}`);
  }
  for (const [key, content] of Object.entries(values).filter(([key]) =>
    ["document", "code", "read", "attachment"].includes(key),
  )) {
    const path = paths[key];
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
  }
  for (const document of values.wikiDocuments)
    await writeFile(document.path, document.content, { flag: "wx" });
  await mkdir(paths.wiki, { recursive: true });
  for (const skill of skills) {
    await mkdir(join(skill.path, ".."), { recursive: true });
    await writeFile(
      skill.path,
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.sentinel}\nRead ${paths.read} using the real read tool. Preserve the supplied user arguments.\n`,
      { flag: "wx" },
    );
  }
  await promisify(execFile)("git", ["init", "--quiet", workspace], {
    cwd: workspace,
    windowsHide: true,
  });
  await promisify(execFile)(
    "git",
    ["add", "--", "native-code/timing.mjs", "native-docs/timing.md"],
    { cwd: workspace, windowsHide: true },
  );
  await promisify(execFile)(
    "git",
    [
      "-c",
      "user.name=Native Acceptance",
      "-c",
      "user.email=native-acceptance@invalid.example",
      "commit",
      "--quiet",
      "-m",
      "Owned native index inputs",
    ],
    { cwd: workspace, windowsHide: true },
  );
}
