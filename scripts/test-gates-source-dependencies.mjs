import { dirname, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { createSourceBindingAnalyzer } from "./test-gates-source-bindings.mjs";

const ts = createRequire(import.meta.url)("@typescript/typescript6");

export function workspaceSourcePath(workspace, path) {
  // Resolve workspace-package links before excluding installed dependencies.
  const canonical = ts.sys.realpath?.(path) ?? path;
  const local = relative(workspace, canonical).replaceAll("\\", "/");
  return {
    canonical,
    local,
    external:
      isAbsolute(local) ||
      local === ".." ||
      local.startsWith("../") ||
      local.split("/").includes("node_modules"),
  };
}

export function createSourceDependencyAnalyzer({
  workspace,
  excludes,
  codePatterns,
  runnableEntries,
}) {
  function repoPath(path) {
    return relative(workspace, path).replaceAll("\\", "/");
  }
  function workspacePath(path) {
    return workspaceSourcePath(workspace, path);
  }
  // These owners return recipes; merely naming another recipe is not a read of
  // its entry's contents. Each selected recipe/lifecycle is expanded separately.
  const recipeModules = new Set([
    "scripts/test-gates-plan.mjs",
    "scripts/test-gates-workspace-plan.mjs",
    // 输出表只是 producer 配方，现存 build-ready/metadata 不是源码读取输入。
    "scripts/test-gates-build-outputs.mjs",
  ]);
  const dataOperations = new Set([
    "URL",
    "join",
    "resolve",
    "readFile",
    "readFileSync",
    "open",
    "openSync",
    "createReadStream",
    "copyFile",
    "copyFileSync",
    "cp",
    "cpSync",
    "spawn",
    "spawnSync",
    "fork",
    "execFile",
    "execFileSync",
  ]);
  const entryLiterals = new Map();
  for (const entry of runnableEntries) {
    const segments = entry.split("/");
    for (let index = 0; index < segments.length; index++) {
      const suffix = segments.slice(index).join("/");
      if (!entryLiterals.has(suffix)) entryLiterals.set(suffix, []);
      entryLiterals.get(suffix).push(entry);
    }
  }
  const configCache = new Map();
  const configPathCache = new Map();
  const dependencyCache = new Map();
  const sourceCache = new Map();
  const sourceTextCache = new Map();
  const analyzeBindings = createSourceBindingAnalyzer(workspace);
  const fileFactsCache = new Map();
  const moduleResolutionCaches = new Map();
  const dependencyPathCache = new Map();
  function sourceText(path) {
    const absolute = resolve(path);
    if (!sourceTextCache.has(absolute)) sourceTextCache.set(absolute, ts.sys.readFile(path));
    return sourceTextCache.get(absolute);
  }
  function fileConfig(stage) {
    const args = stage.args ?? [];
    const flag = args.findIndex((argument) => argument === "--tsconfig");
    const explicit =
      flag >= 0 ? args[flag + 1] : args.find((arg) => arg.startsWith("--tsconfig="))?.slice(11);
    let config;
    if (explicit) {
      config = resolve(explicit);
    } else {
      const directory = dirname(resolve(stage.testFile));
      if (!configPathCache.has(directory))
        configPathCache.set(
          directory,
          ts.findConfigFile(directory, ts.sys.fileExists) ?? resolve("tsconfig.base.json"),
        );
      config = configPathCache.get(directory);
    }
    if (!configCache.has(config)) {
      const configInput = workspacePath(config);
      const inputs = new Set(configInput.external ? [] : [configInput.local]);
      const parsed = ts.getParsedCommandLineOfConfigFile(
        config,
        {},
        {
          ...ts.sys,
          // Only options/references are needed; do not enumerate project sources.
          readDirectory() {
            return [];
          },
          readFile(path) {
            const input = workspacePath(path);
            if (!input.external) inputs.add(input.local);
            return sourceText(path);
          },
          onUnRecoverableConfigFileDiagnostic(error) {
            throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
          },
        },
      );
      if (!parsed) throw new Error(`Cannot parse test tsconfig ${config}`);
      const errors = parsed.errors.filter((error) => error.code !== 18003);
      if (errors.length)
        throw new Error(
          errors
            .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
            .join("\n"),
        );
      configCache.set(config, { options: parsed.options, inputs, config });
    }
    return configCache.get(config);
  }
  function analyze({ testFile, args, packages, runtime, metadata }) {
    const configuration = fileConfig({ testFile, args });
    const key = JSON.stringify([testFile, configuration.config, packages, runtime, metadata]);
    if (dependencyCache.has(key)) return dependencyCache.get(key);
    const inputs = new Set(configuration.inputs);
    const pending = [];
    const visited = new Set();
    let conservative = false;
    if (!moduleResolutionCaches.has(configuration.config))
      moduleResolutionCaches.set(
        configuration.config,
        ts.createModuleResolutionCache(workspace, (path) => path, configuration.options),
      );
    const moduleCache = moduleResolutionCaches.get(configuration.config);
    let recording;
    function enqueue(path) {
      // Resolve workspace-package symlinks without traversing third-party packages.
      let fact = dependencyPathCache.get(path);
      if (!fact) {
        const boundary = workspacePath(path);
        const { canonical, local } = boundary;
        fact = {
          ...boundary,
          excludedCode:
            codePatterns.some((pattern) => matchesGlob(local, pattern)) &&
            excludes.some((pattern) => matchesGlob(local, pattern)),
        };
        dependencyPathCache.set(path, fact);
        dependencyPathCache.set(canonical, fact);
      }
      if (fact.external) return;
      const { canonical, local } = fact;
      recording?.dependencies.add(canonical);
      conservative ||= fact.excludedCode;
      inputs.add(local);
      pending.push(canonical);
    }
    enqueue(resolve(testFile));
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      inputs.add(repoPath(file));
      if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
      const factsKey = JSON.stringify([file, configuration.config, runtime, metadata]);
      const facts = fileFactsCache.get(factsKey);
      if (facts) {
        conservative ||= facts.conservative;
        for (const dependency of facts.dependencies) enqueue(dependency);
        continue;
      }
      // Isolate this file's facts from its caller's accumulated fallback state.
      // The closure is assembled per target; parsing/resolution/I/O discovery is
      // performed only once per file and analysis mode in this process.
      const inheritedConservative = conservative;
      conservative = false;
      recording = { dependencies: new Set() };
      const sourceKey = JSON.stringify([file, configuration.config]);
      let source = sourceCache.get(sourceKey);
      if (!source) {
        const text = sourceText(file);
        if (text === undefined) throw new Error(`Cannot read test dependency ${file}`);
        source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(
          file,
          undefined,
          ts.sys,
          configuration.options,
        );
        sourceCache.set(sourceKey, source);
      }
      const bindings = analyzeBindings(source, configuration.options);
      conservative ||= bindings.conservative;
      function moduleReference(literal, mode) {
        if (!literal || !ts.isStringLiteralLike(literal)) {
          // A template ending in e.g. /package.json cannot load a runnable test.
          // Keep only candidates compatible with its known suffix.
          const suffix =
            literal && ts.isTemplateExpression(literal)
              ? literal.templateSpans.at(-1)?.literal.text
              : undefined;
          if (!suffix || !/\.(?:json|node)$/u.test(suffix)) conservative = true;
          if (suffix)
            for (const entry of runnableEntries) {
              if (entry.endsWith(suffix)) enqueue(resolve(entry));
            }
          else conservative = true;
          return;
        }
        const specifier = literal.text;
        const result = ts.resolveModuleName(
          specifier,
          file,
          configuration.options,
          ts.sys,
          moduleCache,
          undefined,
          mode,
        ).resolvedModule;
        if (result) enqueue(result.resolvedFileName);
        else if (!isBuiltin(specifier)) conservative = true;
      }
      function dataLiteral(node) {
        if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) return true;
        for (let parent = node.parent; parent && !ts.isStatement(parent); parent = parent.parent) {
          if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) continue;
          const expression = parent.expression;
          const name = ts.isIdentifier(expression)
            ? expression.text
            : ts.isPropertyAccessExpression(expression)
              ? expression.name.text
              : "";
          if (dataOperations.has(name)) return true;
        }
        return false;
      }
      function visit(node) {
        if (runtime && ts.isTypeNode(node)) return;
        if (
          runtime &&
          ((ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
            (ts.isImportDeclaration(node) &&
              !node.importClause?.name &&
              node.importClause?.namedBindings &&
              ts.isNamedImports(node.importClause.namedBindings) &&
              node.importClause.namedBindings.elements.length > 0 &&
              node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)) ||
            (ts.isExportDeclaration(node) && node.isTypeOnly) ||
            (ts.isExportDeclaration(node) &&
              node.exportClause &&
              ts.isNamedExports(node.exportClause) &&
              node.exportClause.elements.length > 0 &&
              node.exportClause.elements.every((element) => element.isTypeOnly)) ||
            (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) ||
            ts.isImportTypeNode(node))
        )
          return;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier)
            moduleReference(
              node.moduleSpecifier,
              ts.getModeForUsageLocation(source, node.moduleSpecifier, configuration.options),
            );
        } else if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference)
        ) {
          moduleReference(node.moduleReference.expression, ts.ModuleKind.CommonJS);
        } else if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteralLike(node.argument.literal)
        ) {
          moduleReference(
            node.argument.literal,
            ts.getModeForUsageLocation(source, node.argument.literal, configuration.options),
          );
        } else if (ts.isCallExpression(node)) {
          const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
          const requireCall =
            (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
            (ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === "require" &&
              node.expression.name.text === "resolve");
          if (dynamicImport || requireCall)
            moduleReference(
              node.arguments[0],
              requireCall ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
            );
          const role = bindings.expressionRole(node.expression);
          if (role === "scan" || role === "opaque") conservative = true;
          if (
            runtime &&
            (role === "execute" ||
              (ts.isIdentifier(node.expression) && node.expression.text === "eval"))
          )
            conservative = true;
          if (role === "read") {
            const argument = node.arguments[0];
            const literal =
              argument && ts.isStringLiteralLike(argument)
                ? argument
                : argument &&
                    ts.isNewExpression(argument) &&
                    ts.isIdentifier(argument.expression) &&
                    argument.expression.text === "URL" &&
                    argument.arguments?.[1]?.getText(source) === "import.meta.url" &&
                    ts.isStringLiteralLike(argument.arguments[0])
                  ? argument.arguments[0]
                  : undefined;
            if (!literal) conservative = true;
            else {
              const path =
                argument === literal ? resolve(literal.text) : resolve(dirname(file), literal.text);
              if (ts.sys.fileExists(path)) enqueue(path);
              else conservative = true;
            }
          }
        }
        if (
          ts.isIdentifier(node) ||
          ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)
        ) {
          const role = bindings.expressionRole(node);
          const declaration = bindings.isDeclaration(node);
          const selectedMember =
            (ts.isPropertyAccessExpression(node.parent) ||
              ts.isElementAccessExpression(node.parent)) &&
            node.parent.expression === node;
          const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
          // Escaping a real reader/namespace can conceal dynamic I/O. Mere type
          // fields and identically named class/object members have no such role.
          if (role && !declaration && !selectedMember && !called) conservative = true;
        }
        // A runnable entry can also be consumed as data (readFile/new URL/spawn).
        // Exact literal paths are not necessarily module specifiers.
        if (
          ts.isStringLiteralLike(node) &&
          (!recipeModules.has(repoPath(file)) || dataLiteral(node))
        ) {
          for (const candidate of [resolve(dirname(file), node.text), resolve(node.text)]) {
            if (ts.sys.fileExists(candidate)) enqueue(candidate);
          }
          for (const entry of entryLiterals.get(node.text.replaceAll("\\", "/")) ?? [])
            enqueue(resolve(entry));
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const reference of runtime ? [] : source.referencedFiles) {
        const dependency = resolve(dirname(file), reference.fileName);
        if (ts.sys.fileExists(dependency)) enqueue(dependency);
        else conservative = true;
      }
      fileFactsCache.set(factsKey, {
        dependencies: [...recording.dependencies],
        conservative,
      });
      recording = undefined;
      conservative ||= inheritedConservative;
    }
    // Unknown runtime module paths must not masquerade as a precise cache. Keep
    // all runnable entries in that target's package/runner scope in this case.
    if (conservative && !metadata) {
      for (const entry of runnableEntries)
        if (
          !packages.length ||
          entry.startsWith("scripts/") ||
          entry.startsWith("gates/") ||
          packages.some((directory) => entry.startsWith(`packages/${directory}/`))
        )
          inputs.add(entry);
    }
    const result = { inputs: [...inputs].sort(), conservative };
    dependencyCache.set(key, result);
    return result;
  }
  return analyze;
}
