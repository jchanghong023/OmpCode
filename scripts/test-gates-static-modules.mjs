import { createRequire, isBuiltin } from "node:module";
import { resolve } from "node:path";
import { workspaceSourcePath } from "./test-gates-source-dependencies.mjs";

const ts = createRequire(import.meta.url)("@typescript/typescript6");

// 包装器只共享静态模块闭包；其运行期 fixture/收据读盘不代表每个目标消费整个产品源码。
export function staticModuleInputs(workspace, entries) {
  const options = {
    allowJs: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const cache = ts.createModuleResolutionCache(workspace, (path) => path, options);
  const inputs = new Set();
  const pending = entries.map((entry) => resolve(workspace, entry));
  while (pending.length) {
    const file = pending.pop();
    const input = workspaceSourcePath(workspace, file);
    if (input.external || inputs.has(input.local)) continue;
    inputs.add(input.local);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) continue;
    const text = ts.sys.readFile(input.canonical);
    if (text === undefined) throw new Error(`Cannot read wrapper module ${input.local}`);
    const source = ts.createSourceFile(input.canonical, text, ts.ScriptTarget.Latest, true);
    source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options);
    function moduleReference(literal, mode) {
      if (!literal || !ts.isStringLiteralLike(literal) || isBuiltin(literal.text)) return;
      const result = ts.resolveModuleName(
        literal.text,
        input.canonical,
        options,
        ts.sys,
        cache,
        undefined,
        mode,
      ).resolvedModule;
      if (result) pending.push(result.resolvedFileName);
      else throw new Error(`Cannot resolve wrapper module ${literal.text} from ${input.local}`);
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier)
          moduleReference(
            node.moduleSpecifier,
            ts.getModeForUsageLocation(source, node.moduleSpecifier, options),
          );
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        moduleReference(node.moduleReference.expression, ts.ModuleKind.CommonJS);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        moduleReference(node.arguments[0], ts.ModuleKind.CommonJS);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return [...inputs].sort();
}

export function createStageEntrypointReader(workspace) {
  function stageEntrypoints(stage) {
    const inline = [];
    for (let index = 0; index < (stage.args ?? []).length; index++) {
      const argument = stage.args[index];
      const code =
        argument === "--eval" || argument === "-e"
          ? stage.args[index + 1]
          : argument.startsWith("--eval=")
            ? argument.slice(7)
            : undefined;
      if (!code) continue;
      for (const reference of ts.preProcessFile(code, true, true).importedFiles) {
        const module = ts.resolveModuleName(
          reference.fileName,
          resolve(workspace, "__gate_inline__.mts"),
          {
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            allowJs: true,
          },
          ts.sys,
          undefined,
          undefined,
          ts.ModuleKind.ESNext,
        ).resolvedModule;
        if (module) {
          const input = workspaceSourcePath(workspace, module.resolvedFileName);
          if (!input.external) inline.push(input.local);
        }
      }
    }
    return [
      ...new Set([
        ...(stage.testFile ? [stage.testFile] : []),
        ...inline,
        ...(stage.args ?? []).filter(
          (argument) =>
            /^(?:packages|scripts)\//u.test(argument) && /\.(?:[cm]?[jt]sx?)$/u.test(argument),
        ),
        ...(stage.lifecycle ?? []).flatMap(stageEntrypoints),
      ]),
    ].sort();
  }
  return stageEntrypoints;
}
