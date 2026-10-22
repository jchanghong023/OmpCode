import ts from "typescript";
import { readFile, readdir } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { builtinModules, createRequire } from "node:module";
import { cssSyntaxNames } from "./centos7-browser-compat.mjs";

const slash = (value) => value.replaceAll("\\", "/");
const js = /\.[cm]?[jt]sx?$/u;
const declaration = /\.d\.[cm]?ts$/u;
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const ignored = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".turbo",
  "out",
  "dist",
  "coverage",
  "release",
  "artifacts",
]);
const test = /(?:^|\/)(?:test|tests|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\./u;
const hostDomain = (path) => (test.test(path) ? "test-current-node" : "build-current-node");
const runtimeDomain = (path) =>
  path.includes("/preload/")
    ? "preload"
    : path.includes("/renderer/")
      ? "renderer"
      : "electron-node";

async function walk(directory, include, excluded = ignored) {
  const result = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const path = slash(resolve(directory, entry.name));
    if (entry.isDirectory() && !excluded.has(entry.name))
      result.push(...(await walk(path, include, excluded)));
    else if (entry.isFile() && include(path)) result.push(path);
  }
  return result.sort();
}

/** One inventory, no API availability inference: declarations belong to the fixed-target checker. */
export async function collectCentos7Inventory({
  root,
  out = resolve(root, "packages/desktop/out"),
  sourceOnly = false,
  bcd,
}) {
  root = slash(resolve(root));
  out = slash(resolve(out));
  const rel = (path) => slash(relative(root, path));
  const abs = (path) => slash(resolve(path));
  const desktop = resolve(root, "packages/desktop");
  const repository = await walk(
    root,
    (path) => (js.test(path) && !declaration.test(path)) || path.endsWith(".css"),
  );
  const repositorySet = new Set(repository);
  const sourceTextByPath = new Map();
  const parsed = new Map();
  const graph = new Map();
  const imports = [];
  const electronAccesses = [];
  const nodeAccesses = [];
  const unresolved = [];
  const entries = [];
  const domains = new Map();
  const bundled = new Set();
  const metadataDomains = new Set();
  const externalEdges = new Map();
  const outputExternals = new Map();
  const metadataFiles = [];
  const configs = new Map();
  const cssPaths = new Set(repository.filter((path) => path.endsWith(".css")));
  const generatedCss = new Set();
  const dependencies = [];

  function optionsFor(file) {
    const config = ts.findConfigFile(dirname(file), ts.sys.fileExists);
    if (!config)
      return {
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
      };
    if (!configs.has(config)) {
      const json = ts.readConfigFile(config, ts.sys.readFile);
      configs.set(
        config,
        ts.parseJsonConfigFileContent(json.config, ts.sys, dirname(config)).options,
      );
    }
    return configs.get(config);
  }
  function resolveImport(module, file, external = false) {
    if (!module || module === "electron" || module.startsWith("node:") || builtins.has(module))
      return null;
    const name = module.split("?")[0];
    if (external) {
      try {
        return abs(createRequire(file).resolve(name));
      } catch {
        return null;
      }
    }
    if (name.startsWith(".") && /\.(?:css|html)$/u.test(name))
      return abs(resolve(dirname(file), name));
    const found = ts.resolveModuleName(name, file, optionsFor(file), ts.sys).resolvedModule;
    if (found && !declaration.test(found.resolvedFileName)) return abs(found.resolvedFileName);
    const options = optionsFor(file);
    for (const [pattern, replacements] of Object.entries(options.paths ?? {})) {
      const [prefix, suffix = ""] = pattern.split("*");
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const middle = name.slice(prefix.length, suffix ? -suffix.length : undefined);
      for (const replacement of replacements) {
        const path = resolve(
          options.baseUrl ?? options.pathsBasePath ?? dirname(file),
          replacement.replace("*", middle),
        );
        if (ts.sys.fileExists(path)) return abs(path);
      }
    }
    try {
      return abs(createRequire(file).resolve(name));
    } catch {
      return null;
    }
  }
  async function textFor(file) {
    const path = rel(file);
    if (!sourceTextByPath.has(path)) sourceTextByPath.set(path, await readFile(file, "utf8"));
    return sourceTextByPath.get(path);
  }
  function location(node, source) {
    return {
      path: rel(source.fileName),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    };
  }
  async function scan(file) {
    if (parsed.has(file) || !js.test(file) || declaration.test(file)) return;
    const source = ts.createSourceFile(file, await textFor(file), ts.ScriptTarget.Latest, true);
    parsed.set(file, true);
    const edges = [];
    graph.set(file, edges);
    const bindings = new Map();
    const requireNames = new Set(["require"]);
    const createRequires = new Set();
    const scopes = new WeakMap();
    const isScope = (node) =>
      ts.isSourceFile(node) ||
      ts.isFunctionLike(node) ||
      ts.isBlock(node) ||
      ts.isCatchClause(node);
    function declare(name, declarationNode) {
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const item of name.elements)
          if (ts.isBindingElement(item)) declare(item.name, declarationNode);
      } else if (ts.isIdentifier(name)) {
        let scope = declarationNode.parent;
        while (scope && !isScope(scope)) scope = scope.parent;
        if (scope) {
          if (!scopes.has(scope)) scopes.set(scope, new Map());
          scopes.get(scope).set(name.text, declarationNode);
        }
      }
    }
    function gather(node) {
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isImportSpecifier(node) ||
          ts.isNamespaceImport(node) ||
          ts.isImportClause(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        node.name
      )
        declare(node.name, node);
      ts.forEachChild(node, gather);
    }
    gather(source);
    function bindingAt(identifier) {
      if (!ts.isIdentifier(identifier)) return null;
      const binding = bindings.get(identifier.text);
      if (!binding) return null;
      for (let scope = identifier; scope; scope = scope.parent) {
        const declarationNode = scopes.get(scope)?.get(identifier.text);
        if (declarationNode) return declarationNode === binding.declaration ? binding : null;
      }
      return binding;
    }
    function bind(local, imported, module, declarationNode, typeOnly = false) {
      bindings.set(local, { module, imported, declaration: declarationNode, typeOnly });
      if (["node:module", "module"].includes(module) && imported === "createRequire")
        createRequires.add(local);
    }
    function addImport(node, module, names, typeOnly, kind) {
      const target = resolveImport(module, file, !repositorySet.has(file));
      const builtin =
        module && (builtins.has(module.replace(/^node:/u, "")) || module.startsWith("node:"))
          ? module.replace(/^node:/u, "")
          : null;
      const item = {
        ...location(node, source),
        module,
        names,
        typeOnly,
        kind,
        builtin,
        resolved: target ? rel(target) : null,
      };
      imports.push(item);
      if (!module)
        unresolved.push({
          ...location(node, source),
          kind: "dynamic-import",
          expression: node.getText(source),
        });
      if (target && !typeOnly) edges.push({ path: target, module });
    }
    for (const node of source.statements) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const module = node.moduleSpecifier.text;
        const names = [];
        const clause = node.importClause;
        if (clause?.name) {
          names.push({
            imported: "default",
            local: clause.name.text,
            typeOnly: Boolean(clause.isTypeOnly),
          });
          bind(clause.name.text, "default", module, clause, clause.isTypeOnly);
        }
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          const binding = clause.namedBindings;
          names.push({
            imported: "*",
            local: binding.name.text,
            typeOnly: Boolean(clause.isTypeOnly),
          });
          bind(binding.name.text, "*", module, binding, clause.isTypeOnly);
        } else if (clause?.namedBindings) {
          for (const binding of clause.namedBindings.elements) {
            const imported = binding.propertyName?.text ?? binding.name.text;
            const typeOnly = Boolean(clause.isTypeOnly || binding.isTypeOnly);
            names.push({ imported, local: binding.name.text, typeOnly });
            bind(binding.name.text, imported, module, binding, typeOnly);
          }
        }
        if (
          ts.isExportDeclaration(node) &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause)
        )
          for (const binding of node.exportClause.elements)
            names.push({
              imported: binding.propertyName?.text ?? binding.name.text,
              local: binding.name.text,
              typeOnly: Boolean(node.isTypeOnly || binding.isTypeOnly),
            });
        const typeOnly = Boolean(
          node.isTypeOnly ||
          clause?.isTypeOnly ||
          (names.length && names.every((name) => name.typeOnly)),
        );
        addImport(
          node,
          module,
          names,
          typeOnly,
          ts.isImportDeclaration(node) ? "import" : "export",
        );
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const module = node.moduleReference.expression;
        if (module && ts.isStringLiteralLike(module)) {
          bind(node.name.text, "*", module.text, node, node.isTypeOnly);
          addImport(
            node,
            module.text,
            [{ imported: "*", local: node.name.text, typeOnly: Boolean(node.isTypeOnly) }],
            Boolean(node.isTypeOnly),
            "import-equals",
          );
        }
      }
    }
    function unwrap(node) {
      while (
        node &&
        (ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isNonNullExpression(node) ||
          ts.isParenthesizedExpression(node))
      )
        node = node.expression;
      return node;
    }
    function platformPath(node) {
      node = unwrap(node);
      if (!node) return null;
      if (ts.isIdentifier(node)) {
        const binding = bindingAt(node);
        return binding && !binding.typeOnly
          ? {
              ...binding,
              members: ["*", "default"].includes(binding.imported) ? [] : [binding.imported],
            }
          : null;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const parent = platformPath(node.expression);
        const member = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : null;
        return parent ? { ...parent, members: [...parent.members, member ?? "<computed>"] } : null;
      }
      return null;
    }
    function aliasPass(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initial = unwrap(node.initializer);
        if (
          ts.isIdentifier(node.name) &&
          ts.isIdentifier(initial) &&
          requireNames.has(initial.text)
        )
          requireNames.add(node.name.text);
        if (ts.isIdentifier(node.name) && ts.isCallExpression(initial)) {
          const path = platformPath(initial.expression);
          if (
            (ts.isIdentifier(initial.expression) && createRequires.has(initial.expression.text)) ||
            (path?.module.replace(/^node:/u, "") === "module" &&
              path.members.join(".") === "createRequire")
          )
            requireNames.add(node.name.text);
        }
        let path = platformPath(initial);
        if (
          ts.isCallExpression(initial) &&
          ts.isIdentifier(initial.expression) &&
          requireNames.has(initial.expression.text) &&
          initial.arguments[0] &&
          ts.isStringLiteralLike(initial.arguments[0])
        )
          path = { module: initial.arguments[0].text, members: [] };
        if (path) {
          if (ts.isIdentifier(node.name))
            bind(node.name.text, path.members.join(".") || "*", path.module, node);
          else if (ts.isObjectBindingPattern(node.name))
            for (const binding of node.name.elements) {
              if (ts.isIdentifier(binding.name))
                bind(
                  binding.name.text,
                  [...path.members, binding.propertyName?.text ?? binding.name.text].join("."),
                  path.module,
                  node,
                );
            }
        }
      }
      ts.forEachChild(node, aliasPass);
    }
    // Two passes cover require/createRequire and ordinary aliases without interpreting code.
    aliasPass(source);
    aliasPass(source);
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)))
      ) {
        const arg = node.arguments[0];
        const module = arg && ts.isStringLiteralLike(arg) ? arg.text : null;
        const names = [];
        if (ts.isVariableDeclaration(node.parent)) {
          const name = node.parent.name;
          if (ts.isIdentifier(name))
            names.push({ imported: "*", local: name.text, typeOnly: false });
          else if (ts.isObjectBindingPattern(name))
            for (const item of name.elements)
              if (ts.isIdentifier(item.name))
                names.push({
                  imported: item.propertyName?.text ?? item.name.text,
                  local: item.name.text,
                  typeOnly: false,
                });
        }
        addImport(
          node,
          module,
          names,
          false,
          node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require",
        );
      }
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node) ||
        ((ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          ts.isIdentifier(node.expression))
      ) {
        const expression =
          ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : node;
        const path = platformPath(expression);
        if (
          path &&
          (path.module === "electron" ||
            builtins.has(path.module.replace(/^node:/u, "")) ||
            path.module.startsWith("node:"))
        ) {
          const members = path.members.flatMap((part) => part.split("."));
          const [owner, ...rest] = members;
          if (owner) {
            const item = {
              ...location(node, source),
              module: path.module,
              owner,
              member: rest.join("."),
              expression: expression.getText(source),
              optional: Boolean(node.questionDotToken),
            };
            (path.module === "electron" ? electronAccesses : nodeAccesses).push(item);
            if (members.includes("<computed>"))
              unresolved.push({ ...item, kind: "dynamic-api-member" });
          }
        }
        if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression))
          nodeAccesses.push({
            ...location(node, source),
            module: "import.meta",
            owner: "import.meta",
            member: node.name.text,
            expression: node.getText(source),
            optional: false,
          });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  // Discover entries from the actual build configuration AST, never a directory allowlist.
  const tsup = resolve(desktop, "tsup.config.ts");
  const configSource = ts.createSourceFile(tsup, await textFor(tsup), ts.ScriptTarget.Latest, true);
  function entryVisitor(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(configSource) === "entry" &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
          const path = abs(resolve(desktop, property.initializer.text));
          entries.push({ path: rel(path), domain: runtimeDomain(slash(path)), source: rel(tsup) });
        }
    ts.forEachChild(node, entryVisitor);
  }
  entryVisitor(configSource);
  // CLI 由 Electron 的 Node 子进程执行，不能因位于 apps/ 而漏归为构建脚本。
  // 路径对应 CLI build.mjs 的 entryPoints/outfile 与 manager 的 resources/glm/zcode.cjs。
  const agentRoot = resolve(root, "apps/zcode-cli/packages/cli");
  const agentBuild = resolve(agentRoot, "scripts/build.mjs");
  const agentEntry = resolve(agentRoot, "src/main.ts");
  const agentBundle = resolve(agentRoot, "dist/zcode.cjs");
  entries.push({
    path: rel(agentEntry),
    domain: "agent-node",
    source: rel(agentBuild),
    output: rel(agentBundle),
    resource: "resources/glm/zcode.cjs",
  });
  const vite = resolve(desktop, "vite.config.ts");
  const viteSource = ts.createSourceFile(vite, await textFor(vite), ts.ScriptTarget.Latest, true);
  const htmlEntries = [];
  function htmlVisitor(node) {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(viteSource) === "input" &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && ts.isCallExpression(property.initializer)) {
          const name = property.initializer.arguments.find(
            (arg) => ts.isStringLiteralLike(arg) && arg.text.endsWith(".html"),
          );
          if (name) htmlEntries.push(abs(resolve(desktop, name.text)));
        }
    ts.forEachChild(node, htmlVisitor);
  }
  htmlVisitor(viteSource);
  for (const file of htmlEntries) {
    entries.push({ path: rel(file), domain: "renderer", source: rel(vite) });
    const text = await textFor(file);
    const edges = [];
    for (const match of text.matchAll(
      /<(script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/giu,
    )) {
      if (/^(?:https?:|data:|\/\/)/u.test(match[2])) continue;
      const target = abs(
        resolve(
          match[2].startsWith("/") ? resolve(desktop, "src/renderer") : dirname(file),
          match[2].replace(/^\//u, ""),
        ),
      );
      edges.push({ path: target, module: match[2] });
    }
    graph.set(file, edges);
  }
  for (const file of repository) if (js.test(file)) await scan(file);
  for (const entry of entries) domains.set(abs(resolve(root, entry.path)), entry.domain);
  async function expand(queue, actual) {
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index];
      await scan(file);
      for (const edge of graph.get(file) ?? []) {
        if (
          actual &&
          metadataDomains.has(domains.get(file)) &&
          (repositorySet.has(file) || bundled.has(file)) &&
          !repositorySet.has(edge.path) &&
          !bundled.has(edge.path) &&
          !externalEdges.get(file)?.has(edge.module)
        )
          continue;
        if (edge.path.endsWith(".css")) cssPaths.add(edge.path);
        if (!domains.has(edge.path)) {
          domains.set(edge.path, domains.get(file));
          queue.push(edge.path);
        }
      }
    }
  }
  await expand([...domains.keys()], false);
  const sourceDomains = new Map(domains);
  if (!sourceOnly) {
    // CLI 的 metafile 仅在构建内用于身份校验，未落盘；记录真实产物及构建来源，
    // API 仍按源码闭包检查，避免压缩产物丢失 fallback 归属或旧产物掩盖新源码。
    if (ts.sys.fileExists(agentBundle)) {
      metadataFiles.push({
        path: rel(agentBundle),
        domain: "agent-node",
        source: rel(agentBuild),
        resource: "resources/glm/zcode.cjs",
        kind: "runtime-bundle",
      });
    } else {
      unresolved.push({
        path: rel(agentBundle),
        line: 1,
        kind: "missing-agent-bundle",
        expression: "resources/glm/zcode.cjs",
        domain: "agent-node",
      });
    }
    for (const file of await walk(
      out,
      (path) => /(?:metafile.*\.json|runtime-modules\.json)$/u.test(path),
      new Set(),
    )) {
      const value = JSON.parse(await readFile(file, "utf8"));
      const domain = /preload/u.test(file)
        ? "preload"
        : /renderer|plugin-sandbox/u.test(file)
          ? "renderer"
          : "electron-node";
      metadataFiles.push({ path: rel(file), domain });
      metadataDomains.add(domain);
      for (const input of Array.isArray(value) ? value : Object.keys(value.inputs ?? {})) {
        const name = input.split("?")[0];
        if (name.startsWith("\0") || !/\.(?:[cm]?[jt]sx?|css)$/u.test(name)) continue;
        const path = abs(isAbsolute(name) ? name : resolve(desktop, name));
        if (!ts.sys.fileExists(path)) {
          unresolved.push({
            path: rel(file),
            line: 1,
            kind: "missing-bundle-input",
            expression: input,
            domain,
          });
          continue;
        }
        bundled.add(path);
        domains.set(path, domain);
        if (path.endsWith(".css")) cssPaths.add(path);
        for (const imported of value.inputs?.[input]?.imports ?? [])
          if (imported.external) {
            if (!externalEdges.has(path)) externalEdges.set(path, new Set());
            externalEdges.get(path).add(imported.path);
          }
      }
      // Output externals may include generated edges absent from input imports.
      for (const output of Object.values(value.outputs ?? {}))
        for (const imported of output.imports ?? [])
          if (
            imported.external &&
            !builtins.has(imported.path.replace(/^node:/u, "")) &&
            imported.path !== "electron"
          ) {
            const entry = resolveImport(imported.path, resolve(desktop, "package.json"), true);
            if (entry) outputExternals.set(entry, domain);
            else
              unresolved.push({
                path: rel(file),
                line: 1,
                kind: "unresolved-external",
                expression: imported.path,
                domain,
              });
          }
    }
    for (const [path, domain] of domains)
      if (metadataDomains.has(domain) && !repositorySet.has(path) && !bundled.has(path))
        domains.delete(path);
    for (const [path, domain] of outputExternals) domains.set(path, domain);
    // Re-admit only real external edges, not package entrypoints hidden by build aliases.
    for (const [parent, modules] of externalEdges)
      for (const module of modules) {
        const target = resolveImport(module, parent, true);
        if (target) domains.set(target, domains.get(parent));
        else if (module !== "electron" && !builtins.has(module.replace(/^node:/u, "")))
          unresolved.push({
            path: rel(parent),
            line: 1,
            kind: "unresolved-external",
            expression: module,
            domain: domains.get(parent),
          });
      }
    await expand([...domains.keys()], true);
    for (const file of await walk(out, (path) => path.endsWith(".css"), new Set())) {
      generatedCss.add(file);
      cssPaths.add(file);
      domains.set(file, "renderer");
    }
  }
  // Record exact selected dependency source/version. No all-package entrypoint admission.
  const packageCache = new Map();
  async function packageFor(file) {
    let directory = dirname(file);
    const visited = [];
    while (directory !== dirname(directory)) {
      if (packageCache.has(directory)) {
        const value = packageCache.get(directory);
        for (const path of visited) packageCache.set(path, value);
        return value;
      }
      visited.push(directory);
      try {
        const path = resolve(directory, "package.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        const result = {
          name: value.name ?? null,
          version: value.version ?? null,
          packageJson: rel(path),
        };
        for (const path of visited) packageCache.set(path, result);
        return result;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
    return null;
  }

  const cssCandidates = [];
  const cssFiles = [];
  const postcss = createRequire(resolve(desktop, "package.json"))("postcss");
  const cssQueue = [...cssPaths].sort();
  for (let index = 0; index < cssQueue.length; index++) {
    const file = cssQueue[index];
    const generated = generatedCss.has(file);
    const domain = domains.get(file) ?? hostDomain(rel(file));
    const ast = postcss.parse(await textFor(file), { from: file });
    cssFiles.push({ path: rel(file), generated, domain });
    const cssEdges = [];
    graph.set(file, cssEdges);
    ast.walkAtRules("import", (node) => {
      const module = /^(?:url\()?\s*["']([^"']+)["']/u.exec(node.params)?.[1];
      if (!module || /^(?:https?:|data:)/u.test(module)) return;
      const target = resolveImport(module, file);
      if (!target?.endsWith(".css")) return;
      cssEdges.push({ path: target, module });
      if (!cssPaths.has(target)) {
        cssPaths.add(target);
        cssQueue.push(target);
      }
    });
    ast.walk((node) => {
      const checks = [];
      if (node.type === "decl") {
        if (!node.prop.startsWith("--")) checks.push({ kind: "css-property", feature: node.prop });
        for (const feature of cssSyntaxNames(node.value, "function"))
          checks.push({ kind: "css-function", feature });
        const cleanValue = node.value.replace(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu, "");
        for (const key of Object.keys(bcd?.css?.properties?.[node.prop] ?? {}))
          if (
            key !== "__compat" &&
            new RegExp(
              `(?:^|[^\\w-])${key.replaceAll("_", "-").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^\\w-])`,
              "u",
            ).test(cleanValue)
          )
            checks.push({ kind: "css-value", feature: `${node.prop}:${key}` });
      } else if (node.type === "atrule") checks.push({ kind: "css-at-rule", feature: node.name });
      else if (node.type === "rule")
        for (const feature of cssSyntaxNames(node.selector, "selector"))
          checks.push({ kind: "css-selector", feature });
      const atRules = [];
      for (let parent = node.parent; parent; parent = parent.parent)
        if (parent.type === "atrule") atRules.push({ name: parent.name, params: parent.params });
      for (const check of checks)
        cssCandidates.push({
          path: rel(file),
          line: node.source?.start?.line ?? 1,
          ...check,
          property: node.prop,
          generated,
          domain,
          context: {
            selector: node.selector ?? node.parent?.selector,
            atRules,
            value: node.value,
            customProperty: Boolean(node.prop?.startsWith("--")),
            priorDecls: (node.parent?.nodes ?? [])
              .slice(0, (node.parent?.nodes ?? []).indexOf(node))
              .filter((item) => item.type === "decl")
              .map((item) => ({ property: item.prop, value: item.value })),
          },
        });
    });
  }
  // CSS imports are edges too; propagate after all rules are parsed so lexical
  // filename order cannot turn an earlier imported stylesheet into build-only.
  for (const selected of [domains, sourceDomains]) {
    const queue = [...selected.keys()];
    for (let index = 0; index < queue.length; index++)
      if (queue[index].endsWith(".css"))
        for (const edge of graph.get(queue[index]) ?? [])
          if (!selected.has(edge.path)) {
            selected.set(edge.path, selected.get(queue[index]));
            queue.push(edge.path);
          }
  }
  for (const [file, domain] of domains)
    if (file.includes("/node_modules/")) {
      const pkg = await packageFor(file);
      dependencies.push({ ...pkg, path: rel(file), domain, bundled: bundled.has(file) });
    }
  const sourceClosure = [...sourceDomains].map(([path, domain]) => ({ path: rel(path), domain }));
  const domainFor = (path) => domains.get(abs(resolve(root, path))) ?? hostDomain(path);
  for (const item of [...cssFiles, ...cssCandidates]) item.domain = domainFor(item.path);
  for (const item of [...imports, ...electronAccesses, ...nodeAccesses, ...unresolved])
    item.domain ??= domainFor(item.path);
  const files = [...new Set([...parsed.keys(), ...cssPaths])]
    .sort()
    .map((path) => ({ path: rel(path), domain: domainFor(rel(path)), bundled: bundled.has(path) }));
  return {
    files,
    imports,
    electronAccesses,
    nodeAccesses,
    cssFiles,
    cssCandidates,
    metadataFiles,
    dependencies,
    entries,
    sourceClosure,
    sourceTextByPath,
    unresolved,
  };
}
