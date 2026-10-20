import { createRequire } from "node:module";
import { resolve } from "node:path";

const ts = createRequire(import.meta.url)("@typescript/typescript6");
const readOperations = new Set([
  "readFile",
  "readFileSync",
  "open",
  "openSync",
  "createReadStream",
]);
const scanOperations = new Set([
  "readdir",
  "readdirSync",
  "opendir",
  "opendirSync",
  "glob",
  "globSync",
  "readDirectory",
]);
const executionOperations = new Set([
  "spawn",
  "spawnSync",
  "fork",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "eval",
]);

// Only filesystem/process binding identity belongs here; import/data closures
// and the decision to widen a target's inputs remain owned by the caller.
export function createSourceBindingAnalyzer(workspace) {
  const checkerCache = new WeakMap();
  return (source, compilerOptions) => {
    const file = resolve(source.fileName);
    const bindingsByName = new Map();
    let conservative = false;
    function addBinding(name, role) {
      if (!bindingsByName.has(name.text)) bindingsByName.set(name.text, []);
      bindingsByName.get(name.text).push({ name, role });
    }
    function moduleRole(name) {
      if (["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(name)) return "fs";
      if (["child_process", "node:child_process"].includes(name)) return "process";
      return undefined;
    }
    function memberRole(namespace, name) {
      if (namespace === "fs") {
        if (name === "promises") return "fs";
        if (readOperations.has(name)) return "read";
        if (scanOperations.has(name)) return "scan";
      }
      if (namespace === "process" && executionOperations.has(name)) return "execute";
      return undefined;
    }
    function identifierRole(node) {
      const candidates = bindingsByName.get(node.text);
      if (!candidates) return undefined;
      let checker = checkerCache.get(source);
      if (!checker) {
        // Bind only this source: no libraries, dependency loading or diagnostics.
        // Official symbol identity distinguishes shadows/property names from
        // actual imported filesystem/process bindings.
        // 独立程序同时绑定 TS 与 JS 入口，不继承产品仅检查 TS 的限制。
        const options = {
          ...compilerOptions,
          allowJs: true,
          noResolve: true,
          noLib: true,
          types: [],
        };
        const program = ts.createProgram([file], options, {
          // CompilerHost 查询用 "/"；Windows realpath 可能返回 "\\"，需统一后匹配。
          getSourceFile: (name) => (resolve(name) === file ? source : undefined),
          getDefaultLibFileName: () => "",
          writeFile() {},
          getCurrentDirectory: () => workspace,
          getCanonicalFileName: (name) =>
            ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(),
          useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
          getNewLine: () => "\n",
          fileExists: (name) => resolve(name) === file,
          readFile: () => undefined,
        });
        if (program.getSourceFile(file) !== source)
          throw new Error(`Dependency source is absent from its binding program: ${file}`);
        checker = program.getTypeChecker();
        checkerCache.set(source, checker);
      }
      const symbol = checker.getSymbolAtLocation(node);
      return candidates.find(
        (binding) => symbol && checker.getSymbolAtLocation(binding.name) === symbol,
      )?.role;
    }
    function expressionRole(expression) {
      if (!expression) return undefined;
      if (ts.isIdentifier(expression)) return identifierRole(expression);
      if (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression))
        return expressionRole(expression.expression);
      if (ts.isPropertyAccessExpression(expression))
        return memberRole(expressionRole(expression.expression), expression.name.text);
      if (ts.isElementAccessExpression(expression)) {
        const namespace = expressionRole(expression.expression);
        return namespace === "fs" || namespace === "process"
          ? ts.isStringLiteralLike(expression.argumentExpression)
            ? memberRole(namespace, expression.argumentExpression.text)
            : "opaque"
          : undefined;
      }
      if (
        ts.isCallExpression(expression) &&
        (expression.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expression.expression) && expression.expression.text === "require")) &&
        expression.arguments[0] &&
        ts.isStringLiteralLike(expression.arguments[0])
      )
        return moduleRole(expression.arguments[0].text);
      return undefined;
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const namespace = moduleRole(statement.moduleSpecifier.text);
        if (!namespace) continue;
        if (statement.importClause?.name) addBinding(statement.importClause.name, namespace);
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) addBinding(bindings.name, namespace);
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements) {
            const role = memberRole(namespace, binding.propertyName?.text ?? binding.name.text);
            if (role) addBinding(binding.name, role);
          }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteralLike(statement.moduleReference.expression)
      ) {
        const role = moduleRole(statement.moduleReference.expression.text);
        if (role) addBinding(statement.name, role);
      }
    }
    function collectAliases(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const role = expressionRole(node.initializer);
        if (role && ts.isIdentifier(node.name)) addBinding(node.name, role);
        if ((role === "fs" || role === "process") && ts.isObjectBindingPattern(node.name))
          for (const binding of node.name.elements) {
            const property = binding.propertyName ?? binding.name;
            if (!ts.isIdentifier(property) || !ts.isIdentifier(binding.name)) {
              conservative = true;
              continue;
            }
            const member = memberRole(role, property.text);
            if (member) addBinding(binding.name, member);
          }
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(source);
    return {
      expressionRole,
      isDeclaration: (node) =>
        ts.isIdentifier(node) &&
        bindingsByName.get(node.text)?.some((binding) => binding.name === node),
      conservative,
    };
  };
}
