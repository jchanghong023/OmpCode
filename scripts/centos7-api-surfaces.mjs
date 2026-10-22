import ts from "typescript";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join, dirname, resolve } from "node:path";

const json = (value) => JSON.stringify(value, null, 2) + "\n";
export async function acquireMetadata(cache, name, version) {
  const directory = join(cache, `${name.replaceAll("/", "+")}@${version}`);
  const required = name === "electron" ? "electron.d.ts" : name === "@types/node" ? "index.d.ts" : "data.json";
  try {
    await readFile(join(directory, required));
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Wrong cached metadata: ${name}@${version}`);
    return directory;
  }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const get = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const metadata = JSON.parse(await get(`https://registry.npmjs.org/${name}/${version}`));
  if (metadata.name !== name || metadata.version !== version) throw new Error(`Incorrect metadata: ${name}@${version}`);
  const archive = await get(metadata.dist.tarball);
  const [algorithm, expected] = metadata.dist.integrity.split("-");
  if (!["sha512", "sha256"].includes(algorithm) || createHash(algorithm).update(archive).digest("base64") !== expected)
    throw new Error(`Invalid archive integrity: ${name}@${version}`);
  const tar = gunzipSync(archive);
  await mkdir(directory, { recursive: true });
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, size) => header.subarray(start, start + size).toString().replace(/\0.*$/su, "");
    const prefix = text(345, 155);
    const member = `${prefix ? prefix + "/" : ""}${text(0, 100)}`.split("/").slice(1).join("/");
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid metadata archive size");
    const destination = resolve(directory, member);
    if (!destination.startsWith(resolve(directory) + "/") && !destination.startsWith(resolve(directory) + "\\")) throw new Error("Unsafe archive member");
    if (["", "0"].includes(text(156, 1))) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  await writeFile(join(directory, "receipt.json"), json({ name, version, url: metadata.dist.tarball, integrity: metadata.dist.integrity }));
  return directory;
}

// A declaration catalog, not a second compiler: overloads, options, events and
// inherited member names remain visible even when the application does not use them.
export function electronCatalog(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const owners = new Map();
  const exports = new Map();
  const declarations = new Map();
  const signature = (node) => node.getText(source).replace(/\/\*[^]*?\*\//gu, "").replace(/\s+/gu, " ").trim();
  function visit(node, namespace = "") {
    if (ts.isModuleDeclaration(node)) {
      const name = node.name.text;
      if (node.body) visit(node.body, namespace ? `${namespace}.${name}` : name);
      return;
    }
    if ((namespace === "Electron" || namespace.startsWith("Electron.")) && (
      ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) ||
      namespace !== "Electron" && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))
    ) && node.name && ts.isIdentifier(node.name)) {
      const key = `${namespace}.${node.name.text}`;
      const signatures = declarations.get(key) ?? [];
      signatures.push(signature(node));
      declarations.set(key, signatures);
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && namespace === "Electron") {
      const owner = node.name.text;
      const record = owners.get(owner) ?? { members: {}, bases: [], events: [] };
      record.bases.push(...(node.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => type.expression.getText(source).replace(/^Electron\./u, ""))));
      for (const member of node.members) {
        const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null;
        if (!name) continue;
        const signature = member.getText(source).replace(/\/\*[^]*?\*\//gu, "").replace(/\s+/gu, " ").trim();
        (record.members[name] ??= []).push(signature);
        const eventType = member.parameters?.[0]?.type;
        if (["on", "once", "addListener"].includes(name) && eventType && ts.isLiteralTypeNode(eventType) && ts.isStringLiteral(eventType.literal) && !record.events.includes(eventType.literal.text)) record.events.push(eventType.literal.text);
      }
      owners.set(owner, record);
    }
    if (ts.isVariableDeclaration(node) && namespace === "Electron" && ts.isIdentifier(node.name) && node.type)
      exports.set(node.name.text, node.type.getText(source).replace(/^typeof\s+/u, "").replace(/^Electron\./u, ""));
    ts.forEachChild(node, (child) => visit(child, namespace));
  }
  visit(source);
  const has = (owner, member, seen = new Set()) => {
    owner = exports.get(owner) ?? owner;
    if (seen.has(owner)) return false;
    seen.add(owner);
    const record = owners.get(owner);
    return Boolean(record && (record.members[member] || record.bases.some((base) => has(base, member, seen))));
  };
  const hasEvent = (owner, event, seen = new Set()) => {
    owner = exports.get(owner) ?? owner;
    if (seen.has(owner)) return false;
    seen.add(owner);
    const record = owners.get(owner);
    return Boolean(record && (record.events.includes(event) || record.bases.some((base) => hasEvent(base, event, seen))));
  };
  return { owners, exports, declarations, has, hasEvent, records: Object.fromEntries([...owners].sort(([a], [b]) => a.localeCompare(b))) };
}

export function electronDifferences(current, target) {
  const result = [];
  for (const [owner, record] of current.owners) {
    if (!target.owners.has(owner)) result.push({ owner, kind: "owner-absent" });
    for (const [member, signatures] of Object.entries(record.members)) {
      if (!target.has(owner, member)) result.push({ owner, member, kind: "member-absent" });
      else if (JSON.stringify(signatures) !== JSON.stringify(target.owners.get(owner)?.members[member]))
        result.push({ owner, member, kind: "signature-difference", current: signatures, target: target.owners.get(owner)?.members[member] ?? [] });
    }
  }
  for (const [name, owner] of current.exports)
    if (!target.exports.has(name)) result.push({ owner, member: name, kind: "export-absent" });
  for (const [name, signatures] of current.declarations) {
    const targetSignatures = target.declarations.get(name);
    if (!targetSignatures) result.push({ declaration: name, kind: "declaration-absent", current: signatures });
    else if (JSON.stringify(signatures) !== JSON.stringify(targetSignatures)) result.push({ declaration: name, kind: "declaration-signature-difference", current: signatures, target: targetSignatures });
  }
  for (const [owner, record] of target.owners) {
    if (!current.owners.has(owner)) result.push({ owner, kind: "target-only-owner" });
    for (const member of Object.keys(record.members))
      if (!current.has(owner, member)) result.push({ owner, member, kind: "target-only-member" });
  }
  for (const [name, owner] of target.exports)
    if (!current.exports.has(name)) result.push({ owner, member: name, kind: "target-only-export" });
  for (const [name, signatures] of target.declarations)
    if (!current.declarations.has(name)) result.push({ declaration: name, kind: "target-only-declaration", target: signatures });
  return result;
}

// One bounded symbol program for application Electron ownership. Dependency
// implementations and their TypeCheckers are deliberately outside this pass.
export function resolveElectronAccesses({ root, inventory, declaration }) {
  const electronImporters = new Set(inventory.imports.filter((item) => item.module?.startsWith("electron")).map((item) => item.path));
  const inputs = inventory.files.filter((file) => !file.path.includes("node_modules/") && /\.[cm]?[jt]sx?$/u.test(file.path) && (["electron-node", "preload"].includes(file.domain) || electronImporters.has(file.path)));
  const paths = new Set(inputs.map((file) => resolve(root, file.path)));
  const options = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true, noLib: true, types: [], allowJs: true };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    if (["electron", "electron/main", "electron/renderer", "electron/common"].includes(name)) return { resolvedFileName: declaration, extension: ts.Extension.Dts };
    if (!name.startsWith(".")) return undefined;
    const base = resolve(dirname(containing), name).replace(/\.[cm]?js$/u, "");
    const match = [base, ...[".ts", ".tsx", ".js", "/index.ts"].map((suffix) => base + suffix)].find((path) => paths.has(path));
    return match ? { resolvedFileName: match } : undefined;
  });
  const program = ts.createProgram([...paths, declaration], options, host);
  const checker = program.getTypeChecker();
  const result = [];
  function electronOwner(symbol) {
    for (const declarationNode of symbol?.declarations ?? []) {
      if (resolve(declarationNode.getSourceFile().fileName) !== resolve(declaration)) continue;
      for (let parent = declarationNode.parent; parent; parent = parent.parent)
        if ((ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name) return parent.name.text;
    }
    return null;
  }
  for (const file of inputs) {
    const source = program.getSourceFile(resolve(root, file.path));
    if (!source) continue;
    function visit(node) {
      let symbol, member;
      if (ts.isPropertyAccessExpression(node)) { symbol = checker.getSymbolAtLocation(node.name); member = node.name.text; }
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
        member = node.argumentExpression.text;
        symbol = checker.getTypeAtLocation(node.expression).getProperty(member);
      } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))) {
        member = node.name.text;
        symbol = checker.getContextualType(node.parent)?.getProperty(member);
      }
      let owner = electronOwner(symbol);
      if (!owner && ts.isPropertyAccessExpression(node) && checker.getTypeAtLocation(node.expression).getSymbol()?.name === "GuestWebContents") owner = "WebContents";
      if (owner) {
        const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
        const event = call && ["on", "once", "addListener"].includes(member) && call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : null;
        result.push({ path: file.path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, module: "electron", owner, member, event, expression: node.getText(source), optional: Boolean(node.questionDotToken), domain: file.domain });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return result;
}

export function nodeCatalog(document) {
  const modules = new Map();
  const collect = (value, module, owner = "") => {
    if (!value || typeof value !== "object") return;
    if (module && typeof value.name === "string" && ["method", "property", "class", "classMethod"].includes(value.type)) {
      const name = value.name.replace(/^node:/u, "").replace(/\([^]*$/u, "");
      modules.get(module).add(name);
      modules.get(module).add(name.split(".").at(-1));
      if (owner) modules.get(module).add(`${owner}.${name}`);
    }
    const nextOwner = value.type === "class" ? value.name.split(".").at(-1) : owner;
    for (const [key, child] of Object.entries(value)) {
      if (["desc", "textRaw", "meta", "signatures"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach((entry) => collect(entry, module, nextOwner));
      else if (child && typeof child === "object") collect(child, module, nextOwner);
    }
  };
  for (const value of document.modules ?? []) {
    const module = /(?:^|\/)([^/]+)\.md$/u.exec(value.source ?? "")?.[1] ?? value.name;
    if (!modules.has(module)) modules.set(module, new Set());
    collect(value, module);
  }
  return modules;
}

// Supplement incomplete documentation headings with the small pinned declaration
// export index. This is an AST inventory, never a dependency TypeChecker.
export async function nodeDeclaredExports(directory) {
  const modules = new Map();
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === "ts4.8") continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.name.endsWith(".d.ts")) continue;
      const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.body && ts.isModuleBlock(node.body)) {
          const name = node.name.text.replace(/^node:/u, "");
          const names = modules.get(name) ?? new Set();
          modules.set(name, names);
          for (const statement of node.body.statements) {
            if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
            if (ts.isVariableStatement(statement))
              for (const declaration of statement.declarationList.declarations)
                if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
            if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause))
              for (const exported of statement.exportClause.elements) if (!exported.isTypeOnly) names.add(exported.name.text);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  await walk(directory);
  return modules;
}
