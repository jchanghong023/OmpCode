#!/usr/bin/env node
// Fixed CentOS 7 admission. Build/test tools continue to use upstream Node.
import ts from "typescript";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { collectCentos7Inventory } from "./centos7-runtime-analysis.mjs";
import { lookupBrowserSupport } from "./centos7-browser-compat.mjs";
import {
  acquireMetadata,
  electronCatalog,
  electronDifferences,
  resolveElectronAccesses,
  nodeCatalog,
  nodeDeclaredExports,
} from "./centos7-api-surfaces.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const sourceOnly = args.includes("--source-only");
const cache = resolve(root, option("--cache", "node_modules/.cache/centos7-runtime-apis"));
const out = resolve(root, option("--desktop-out", "packages/desktop/out"));
const policyPath = resolve(root, "scripts/centos7-runtime-apis.json");
const reportPath = resolve(
  root,
  option("--report", "node_modules/.cache/centos7-runtime-apis/report.json"),
);
const policy = JSON.parse(await readFile(policyPath, "utf8"));
const target = policy.target;
if (target.electron !== "28.3.3" || target.node !== "18.18.2" || target.chrome !== 120)
  throw new Error("This checker admits only CentOS 7 Electron 28.3.3 / Node 18.18.2 / Chrome 120");
const slash = (path) => path.replaceAll("\\", "/");
const rel = (path) => slash(relative(root, resolve(root, path)));
const json = (value) => JSON.stringify(value, null, 2) + "\n";
await mkdir(cache, { recursive: true });
const desktopManifest = JSON.parse(
  await readFile(join(root, "packages/desktop/package.json"), "utf8"),
);
const declaredElectron =
  desktopManifest.devDependencies?.electron ?? desktopManifest.dependencies?.electron;
const desktopRequire = createRequire(join(root, "packages/desktop/package.json"));
let upstreamElectron;
try {
  upstreamElectron = desktopRequire("electron/package.json").version;
} catch {
  if (/^\d+\.\d+\.\d+$/u.test(declaredElectron ?? "")) upstreamElectron = declaredElectron;
  else
    throw new Error(
      "Install the manifest Electron dependency before auditing its declaration catalog",
    );
}
const semver = desktopRequire("semver");
if (!semver.satisfies(upstreamElectron, declaredElectron))
  throw new Error(
    `Installed Electron ${upstreamElectron} does not satisfy manifest ${declaredElectron}`,
  );
const [electronCurrentRoot, electronTargetRoot, bcdRoot, nodeTypesRoot] = await Promise.all([
  acquireMetadata(cache, "electron", upstreamElectron),
  acquireMetadata(cache, "electron", target.electron),
  acquireMetadata(cache, "@mdn/browser-compat-data", policy.metadata.browserCompatData),
  acquireMetadata(cache, "@types/node", "18.18.2"),
]);
const nodeMetadataPath = join(cache, "node-18.18.2-api.json");
const nodeMetadataUrl = "https://nodejs.org/download/release/v18.18.2/docs/api/all.json";
let nodeDocument;
try {
  nodeDocument = JSON.parse(await readFile(nodeMetadataPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(nodeMetadataUrl);
  if (!response.ok) throw new Error(`Node metadata: HTTP ${response.status}`);
  nodeDocument = await response.json();
  await writeFile(nodeMetadataPath, json(nodeDocument));
}
const bcd = JSON.parse(await readFile(join(bcdRoot, "data.json"), "utf8"));
const currentDeclaration = join(electronCurrentRoot, "electron.d.ts");
const currentCatalog = electronCatalog(
  await readFile(currentDeclaration, "utf8"),
  currentDeclaration,
);
const targetCatalog = electronCatalog(
  await readFile(join(electronTargetRoot, "electron.d.ts"), "utf8"),
  "electron-28.d.ts",
);
const differences = electronDifferences(currentCatalog, targetCatalog);
const nodeApis = nodeCatalog(nodeDocument);
const nodeDeclared = await nodeDeclaredExports(nodeTypesRoot);
// These are the exact Node 18 builtin module IDs, including documented subpaths.
// Metadata sections are not module IDs (e.g. fs callback_api is only a heading).
const nodeBuiltins = new Set(
  "assert assert/strict async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https inspector module net os path path/posix path/win32 perf_hooks process punycode querystring readline readline/promises repl stream stream/consumers stream/promises stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8 vm wasi worker_threads zlib test test/reporters original-fs".split(
    " ",
  ),
);
const inventory = await collectCentos7Inventory({ root, out, sourceOnly, bcd });
const findings = [];
const runtime = (item) =>
  ["electron-node", "agent-node", "preload", "renderer", "packaging"].includes(item.domain);
const sourceCache = new Map();
const textFor = (path) =>
  inventory.sourceTextByPath.get(path) ?? inventory.sourceTextByPath.get(resolve(root, path)) ?? "";
function sourceFor(path) {
  if (!sourceCache.has(path))
    sourceCache.set(path, ts.createSourceFile(path, textFor(path), ts.ScriptTarget.Latest, true));
  return sourceCache.get(path);
}
// Syntactic capability evidence is local to the actual access, not a file-wide
// approval. Optional access alone is not proof of an equivalent fallback.
function guardFor(item) {
  const source = sourceFor(item.path);
  const expression = item.expression?.replace(/\?\./gu, ".");
  if (!expression) return null;
  let result = null;
  function containsProbe(node) {
    if (!node) return false;
    if (ts.isTypeOfExpression(node)) {
      const probe = node.expression.getText(source).replace(/\?\./gu, ".");
      return probe === expression || expression.startsWith(probe + ".");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteralLike(node.left)
    ) {
      const probe = `${node.right.getText(source)}.${node.left.text}`;
      return probe === expression;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (containsProbe(child)) found = true;
    });
    return found;
  }
  function visit(node) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (line === item.line && node.getText(source).replace(/\?\./gu, ".") === expression) {
      if (ts.isTypeOfExpression(node.parent)) result = "capability-probe";
      if (
        node.parent &&
        ((ts.isPrefixUnaryExpression(node.parent) &&
          node.parent.operator === ts.SyntaxKind.ExclamationToken) ||
          (ts.isIfStatement(node.parent) && node.parent.expression === node) ||
          (ts.isCallExpression(node.parent) &&
            node.parent.expression.getText(source) === "Boolean"))
      )
        result = "capability-probe";
      for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (
          ts.isConditionalExpression(parent) &&
          parent.whenTrue === child &&
          containsProbe(parent.condition)
        )
          result = "guarded-branch";
        if (
          ts.isIfStatement(parent) &&
          parent.thenStatement === child &&
          containsProbe(parent.expression)
        )
          result = "guarded-branch";
        if (
          ts.isBinaryExpression(parent) &&
          parent.right === child &&
          parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          containsProbe(parent.left)
        )
          result = "guarded-branch";
        if (
          ts.isBinaryExpression(parent) &&
          parent.left === child &&
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        )
          result = "nullish-fallback";
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
function ownership(api, path) {
  return policy.fallbackOwnership.find(
    (record) =>
      record.api === api && (path === record.owner || path.startsWith(record.owner + "/")),
  );
}
function missing(item, kind, api) {
  let guard = guardFor(item);
  const fallback = ownership(api, item.path);
  if (api === "node:sqlite" && fallback) {
    const source = sourceFor(item.path);
    // The one SQLite owner selects a newer native driver before loading it;
    // Node 18 always takes CompatibleDatabase. No generic version evaluator.
    function visit(node) {
      if (
        ts.isConditionalExpression(node) &&
        node.condition.getText(source).replace(/\s+/gu, "") ===
          "major>=24||(major===22&&minor>=16)" &&
        node.whenFalse.kind === ts.SyntaxKind.Identifier &&
        node.whenFalse.text === "undefined"
      ) {
        let nativeLoad = false;
        function load(child) {
          if (
            ts.isCallExpression(child) &&
            child.arguments[0] &&
            ts.isStringLiteralLike(child.arguments[0]) &&
            child.arguments[0].text === "node:sqlite" &&
            source.getLineAndCharacterOfPosition(child.getStart(source)).line + 1 === item.line
          )
            nativeLoad = true;
          ts.forEachChild(child, load);
        }
        load(node.whenTrue);
        if (nativeLoad) guard = "fixed-node-version-selector";
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const handled = Boolean(guard === "capability-probe" || (guard && fallback));
  const finding = {
    ...item,
    kind,
    api,
    guard,
    fallback: fallback ?? null,
    status: handled ? "guarded-fallback" : "missing",
    actionable: runtime(item) && !handled,
  };
  findings.push(finding);
  return finding;
}
const electronUses = resolveElectronAccesses({ root, inventory, declaration: currentDeclaration });
const electronKeys = new Set(
  electronUses.map((item) => `${item.path}:${item.line}:${item.member}`),
);
for (const item of inventory.electronAccesses) {
  if (electronKeys.has(`${item.path}:${item.line}:${item.member}`)) continue;
  const owner = currentCatalog.exports.get(item.owner) ?? item.owner;
  electronUses.push({ ...item, owner });
}
for (const item of electronUses) {
  if (!item.member || item.member.includes(".")) {
    item.status = "unresolved-chain";
    continue;
  }
  if (!item.owner || !currentCatalog.owners.has(item.owner)) {
    item.status = "unresolved-owner";
    continue;
  }
  item.status = targetCatalog.has(item.owner, item.member) ? "supported" : "absent";
  if (item.status === "absent")
    missing(item, "electron-member-absent", `${item.owner}.${item.member}`);
  if (
    item.event &&
    currentCatalog.hasEvent(item.owner, item.event) &&
    !targetCatalog.hasEvent(item.owner, item.event)
  )
    missing(item, "electron-event-absent", `${item.owner}.event:${item.event}`);
}
function hasRuntimeUse(path, local) {
  const source = sourceFor(path);
  let used = false;
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === local) {
      let typeOnly = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (
          ts.isImportDeclaration(parent) ||
          ts.isImportEqualsDeclaration(parent) ||
          ts.isTypeNode(parent)
        ) {
          typeOnly = true;
          break;
        }
        if (ts.isStatement(parent)) break;
      }
      if (!typeOnly) used = true;
    }
    if (!used) ts.forEachChild(node, visit);
  }
  visit(source);
  return used;
}
for (const item of inventory.imports) {
  if (item.typeOnly) continue;
  if (["electron", "electron/main", "electron/renderer", "electron/common"].includes(item.module)) {
    for (const name of item.names) {
      if (name.typeOnly || ["*", "default"].includes(name.imported)) continue;
      if (
        targetCatalog.exports.has(name.imported) ||
        targetCatalog.owners.has(name.imported) ||
        targetCatalog.declarations.has(`Electron.${name.imported}`)
      )
        continue;
      if (item.kind === "import" && !hasRuntimeUse(item.path, name.local)) continue;
      const uses = electronUses.filter(
        (use) =>
          use.path === item.path &&
          (use.owner === (currentCatalog.exports.get(name.imported) ?? name.imported) ||
            use.expression?.startsWith(name.local + ".")),
      );
      const guarded =
        uses.length > 0 &&
        uses.every(
          (use) =>
            targetCatalog.has(use.owner, use.member) ||
            findings.some(
              (finding) =>
                finding.path === use.path &&
                finding.line === use.line &&
                finding.member === use.member &&
                !finding.actionable,
            ),
        );
      findings.push({
        ...item,
        kind: "electron-export-absent",
        api: name.imported,
        status: guarded ? "guarded-fallback" : "missing",
        actionable: runtime(item) && !guarded,
      });
    }
  }
}
const normalizeModule = (name) => name.replace(/^node:/u, "");
const nodeUses = [];
function nodeSupport(module, member) {
  if (!nodeBuiltins.has(module)) return "absent-module";
  if ((policy.node18Absent[module] ?? []).includes(member)) return "absent";
  const base = module.split("/")[0];
  const catalog = nodeApis.get(module) ?? nodeApis.get(base);
  if (catalog?.has(member)) return "supported";
  // Namespace objects are established Node 18 exports; descendants are checked
  // separately when the inventory records the access.
  if (["default", "*"].includes(member)) return "namespace";
  if (nodeDeclared.get(module)?.has(member) || nodeDeclared.get(base)?.has(member))
    return "declared-target-types";
  if (!member.includes(".") && !member.includes("<computed>")) return "absent";
  return "not-in-exact-metadata";
}
for (const item of inventory.imports) {
  if (
    item.typeOnly ||
    !item.module ||
    !(item.builtin || item.module.startsWith("node:") || nodeBuiltins.has(item.module))
  )
    continue;
  const module = normalizeModule(item.module);
  if (!nodeBuiltins.has(module)) missing(item, "node-builtin-absent", `node:${module}`);
  for (const name of item.names) {
    if (name.typeOnly) continue;
    const use = {
      ...item,
      module,
      member: name.imported,
      status: nodeSupport(module, name.imported),
      kind: "named-import",
    };
    nodeUses.push(use);
    if (use.status === "absent") missing(use, "node-api-absent", `${module}.${name.imported}`);
  }
}
for (const item of inventory.nodeAccesses) {
  let module = normalizeModule(item.module);
  let member = [item.owner, item.member].filter(Boolean).join(".");
  if (
    ["promises", "posix", "win32", "web", "types"].includes(item.owner) &&
    nodeBuiltins.has(`${module}/${item.owner}`)
  ) {
    module += `/${item.owner}`;
    member = item.member;
  }
  if (module === "import.meta") {
    const status = ["dirname", "filename"].includes(item.member) ? "absent" : "supported";
    const use = { ...item, status };
    nodeUses.push(use);
    if (status === "absent") missing(use, "node-api-absent", `import.meta.${item.member}`);
    continue;
  }
  const use = { ...item, module, member, status: nodeSupport(module, member) };
  nodeUses.push(use);
  if (["absent", "absent-module"].includes(use.status))
    missing(use, "node-api-absent", `${module}.${member}`);
}
const javascript = [];
function chromeSupport(record) {
  const statements = record?.__compat?.support?.chrome;
  if (!statements) return "unknown";
  for (const statement of Array.isArray(statements) ? statements : [statements]) {
    const added = Number.parseFloat(String(statement.version_added).replace(/^≤/u, ""));
    const removed = Number.parseFloat(String(statement.version_removed).replace(/^≤/u, ""));
    if (
      added <= target.chrome &&
      !(removed <= target.chrome) &&
      !statement.flags?.length &&
      !statement.prefix &&
      !statement.alternative_name &&
      !statement.partial_implementation
    )
      return "supported";
  }
  return "absent";
}
for (const file of inventory.files) {
  if (!/\.[cm]?[jt]sx?$/u.test(file.path)) continue;
  const source = ts.createSourceFile(file.path, textFor(file.path), ts.ScriptTarget.Latest, true);
  const declarations = new Set();
  function bind(node) {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportClause(node) ||
        ts.isImportSpecifier(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      declarations.add(node.name.text);
    ts.forEachChild(node, bind);
  }
  bind(source);
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const expression = node.getText(source);
      const member = node.name.text;
      const isProcess = name === "process" && (policy.node18Absent.process ?? []).includes(member);
      const builtin = !declarations.has(name) ? bcd.javascript?.builtins?.[name]?.[member] : null;
      const browser = file.domain === "renderer" || file.domain === "preload";
      const apiOwner = name === "document" ? "Document" : name === "window" ? "Window" : name;
      const browserRecord =
        browser && !declarations.has(name) ? bcd.api?.[apiOwner]?.[member] : null;
      const record = builtin ?? browserRecord;
      if (record?.__compat || isProcess) {
        const status = isProcess ? "absent" : chromeSupport(record);
        const item = {
          path: file.path,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          domain: file.domain,
          module: isProcess ? "process" : "javascript",
          member,
          expression,
          status,
          support: record?.__compat?.support?.chrome ?? null,
        };
        (isProcess ? nodeUses : javascript).push(item);
        if (status === "absent")
          missing(item, isProcess ? "node-api-absent" : "javascript-api-absent", expression);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const manifests = new Map();
const engineFindings = new Set();
for (const dependency of inventory.dependencies) {
  if (!dependency.packageJson) {
    findings.push({
      ...dependency,
      kind: "missing-dependency-manifest",
      actionable: runtime(dependency),
    });
    continue;
  }
  if (!manifests.has(dependency.packageJson))
    manifests.set(
      dependency.packageJson,
      JSON.parse(await readFile(resolve(root, dependency.packageJson), "utf8")),
    );
  const manifest = manifests.get(dependency.packageJson);
  dependency.nodeEngine = manifest.engines?.node ?? null;
  const key = `${dependency.packageJson}:${dependency.domain}`;
  if (
    !engineFindings.has(key) &&
    dependency.domain !== "renderer" &&
    dependency.nodeEngine &&
    !semver.satisfies(target.node, dependency.nodeEngine, { includePrerelease: true })
  ) {
    findings.push({
      path: dependency.packageJson,
      domain: dependency.domain,
      kind: "dependency-node-engine",
      api: `${dependency.name}@${dependency.version}`,
      required: dependency.nodeEngine,
      actionable: runtime(dependency),
    });
    engineFindings.add(key);
  }
}
const css = [];
const sizingOwner = policy.fallbackOwnership.find((item) => item.api === "field-sizing");
const sizingEvidence = {
  capabilityProbe: false,
  measuredHeight: false,
  measuredWidth: false,
  installed: false,
};
if (
  sizingOwner &&
  inventory.files.some((file) => file.path === sizingOwner.owner && runtime(file))
) {
  const source = sourceFor(sizingOwner.owner);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      if (
        node.expression.getText(source) === "CSS.supports" &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === "field-sizing"
      )
        sizingEvidence.capabilityProbe = true;
      if (ts.isIdentifier(node.expression) && node.expression.text === "useContentSizing")
        sizingEvidence.installed = true;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "getBoundingClientRect"
      )
        sizingEvidence.measuredWidth = true;
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "scrollHeight")
      sizingEvidence.measuredHeight = true;
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const generatedFeatures = new Set(
  (inventory.cssCandidates ?? [])
    .filter((item) => item.generated)
    .map((item) => `${item.kind}:${item.feature}`),
);
for (const item of inventory.cssCandidates ?? []) {
  let support = lookupBrowserSupport(bcd, { ...item, runtimeDomain: item.domain }, target.chrome);
  if (item.generated && support.status === "build-directive")
    support = {
      status: "unsupported",
      evidence: `Compiler directive survived in generated runtime CSS: @${item.feature}`,
    };
  if (support.status === "unsupported") {
    const guard = (item.context?.atRules ?? []).find(
      (rule) =>
        rule.name === "supports" &&
        !/^\s*not\b/u.test(rule.params) &&
        (rule.params.includes(`${item.feature}:`) || rule.params.includes(`${item.feature}(`)),
    );
    const fallback = ownership(item.feature, item.path);
    if (guard && fallback)
      support = { status: "guarded", evidence: support.evidence, guard, fallback };
    else if (
      item.feature === "field-sizing" &&
      /(?:^|[,\s])\.field-sizing-(?:content|fixed)(?:$|[,\s:{])/u.test(
        item.context?.selector ?? "",
      ) &&
      Object.values(sizingEvidence).every(Boolean)
    )
      support = {
        status: "known-fallback",
        evidence: support.evidence,
        fallback: sizingOwner,
        sourceEvidence: sizingEvidence,
      };
    else if (
      !item.generated &&
      !sourceOnly &&
      inventory.cssFiles.some((file) => file.generated) &&
      inventory.files.some((file) => file.path === item.path && file.bundled) &&
      !generatedFeatures.has(`${item.kind}:${item.feature}`)
    )
      support = {
        status: "build-lowered",
        evidence: `${support.evidence}; selected source CSS is a bundle input; feature is absent from actual generated CSS candidates`,
      };
  }
  css.push({ ...item, support });
  if (
    ![
      "supported",
      "build-directive",
      "other-engine-only",
      "build-lowered",
      "known-fallback",
      "guarded",
    ].includes(support.status)
  )
    findings.push({ ...item, kind: "css-target-support", support, actionable: runtime(item) });
}
const packaging = [];
if (!sourceOnly) {
  for (const expected of [
    "runtime-metafile-main.json",
    "runtime-metafile-host.json",
    "runtime-metafile-preload.json",
    "runtime-metafile-scheduler.json",
    "runtime-metafile-plugin-sandbox-alias.json",
    "renderer/runtime-modules.json",
  ]) {
    if (
      !inventory.metadataFiles.some(
        (item) => slash(relative(out, resolve(root, item.path))) === expected,
      )
    )
      packaging.push({
        path: rel(join(out, expected)),
        domain: "packaging",
        kind: "missing-bundle-metadata",
        actionable: true,
      });
  }
  if (!inventory.cssFiles.some((file) => file.generated))
    packaging.push({
      path: rel(out),
      domain: "packaging",
      kind: "missing-generated-css",
      actionable: true,
    });
}
for (const item of inventory.unresolved ?? []) {
  if (!["unresolved-external", "missing-bundle-input", "missing-agent-bundle"].includes(item.kind))
    continue;
  const finding = { ...item, actionable: runtime(item) };
  if (runtime(item)) packaging.push(finding);
  else findings.push(finding);
}
findings.push(...packaging);
const actionable = findings.filter((item) => item.actionable);
const { sourceTextByPath, ...serialInventory } = inventory;
const report = {
  schemaVersion: 3,
  target,
  upstream: { manifestElectron: declaredElectron, installedElectron: upstreamElectron },
  completeness: {
    sourceOnly,
    releaseComplete: !sourceOnly && packaging.length === 0,
    note: sourceOnly
      ? "Source inventory only: generated CSS and actual bundle closure not established; not release admission"
      : "Actual bundle metadata, external closure and generated CSS required",
  },
  metadata: {
    electron: [
      {
        version: upstreamElectron,
        url: `https://registry.npmjs.org/electron/${upstreamElectron}`,
        path: rel(currentDeclaration),
      },
      {
        version: target.electron,
        url: `https://registry.npmjs.org/electron/${target.electron}`,
        path: rel(join(electronTargetRoot, "electron.d.ts")),
      },
    ],
    node: { version: target.node, url: nodeMetadataUrl, path: rel(nodeMetadataPath) },
    browserCompatData: {
      version: policy.metadata.browserCompatData,
      url: `https://registry.npmjs.org/@mdn/browser-compat-data/${policy.metadata.browserCompatData}`,
      path: rel(join(bcdRoot, "data.json")),
    },
  },
  inventory: serialInventory,
  electron: {
    current: currentCatalog.records,
    target: targetCatalog.records,
    currentDeclarations: Object.fromEntries(currentCatalog.declarations),
    targetDeclarations: Object.fromEntries(targetCatalog.declarations),
    currentExports: Object.fromEntries(currentCatalog.exports),
    targetExports: Object.fromEntries(targetCatalog.exports),
    differences,
    accesses: electronUses,
  },
  node: {
    builtinModules: [...nodeBuiltins].sort(),
    declarationExportEvidence:
      "@types/node@18.18.2 supplementary export inventory, not an exact runtime-version equivalence; Node18.18.2 all.json and concrete absent APIs take precedence",
    declarationExports: Object.fromEntries(
      [...nodeDeclared].map(([name, members]) => [name, [...members].sort()]),
    ),
    namedApis: Object.fromEntries(
      [...nodeApis].map(([name, members]) => [name, [...members].sort()]),
    ),
    accesses: nodeUses,
  },
  javascript: {
    scope:
      "AST global/static builtin and document/window accesses; arbitrary receiver types remain in source inventory, not inferred from property spelling",
    accesses: javascript,
  },
  css,
  fallbackOwnership: policy.fallbackOwnership,
  findings,
  summary: {
    actionable: actionable.length,
    guardedFallbacks: findings.filter((item) => item.status === "guarded-fallback").length,
    unresolvedElectronOwners: electronUses.filter((item) => item.status === "unresolved-owner")
      .length,
    nodeMetadataUnknown: nodeUses.filter((item) => item.status === "not-in-exact-metadata").length,
    files: inventory.files.length,
    sourceOnly,
  },
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, json(report));
// --write emits facts, never approvals or source hashes. The checked-in policy
// stays a small fixed target and ownership table independent of upstream versions.
if (args.includes("--write"))
  await writeFile(
    join(cache, "current-target-differences.json"),
    json({
      target,
      upstreamElectron,
      electronDifferences: differences,
      missingApis: findings.filter((item) => /absent/u.test(item.kind)),
      files: inventory.files.map(({ path, domain }) => ({ path, domain })),
    }),
  );
console.log(
  json({
    report: rel(reportPath),
    ...report.summary,
    releaseComplete: report.completeness.releaseComplete,
  }),
);
if (args.includes("--check")) {
  // CLI builtin 缺失必须先报源码证据，不能被 source-only 或其他产物缺失淹没。
  const missingBuiltins = actionable.filter((item) => item.kind === "node-builtin-absent");
  if (missingBuiltins.length > 0)
    console.error(
      json({
        error: "Missing fixed-target Node builtin",
        findings: missingBuiltins.map(({ path, line, domain, api }) => ({
          path,
          line,
          domain,
          api,
        })),
      }),
    );
  if (actionable.length > 0 || sourceOnly) process.exitCode = 1;
}
