
// Resolve the pinned BCD supplied by the audit; no network, runtime probes, or dependencies.
const catalogs = new WeakMap();
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const notes = (statement) => list(statement.notes).join(" ");
const at = (root, path) => path.reduce((value, key) => value?.[key], root);
const versionNumber = (value) =>
  typeof value === "string" && /^≤?\d+(?:\.\d+)*$/u.test(value)
    ? Number.parseFloat(value.replace(/^≤/u, ""))
    : null;

function catalog(bcd) {
  let result = catalogs.get(bcd);
  if (result) return result;
  result = { functions: new Map(), aliases: new Map() };
  const add = (map, name, path) => {
    const entries = map.get(name) ?? [];
    entries.push(path);
    map.set(name, entries);
  };
  function visit(value, path) {
    if (!value || typeof value !== "object") return;
    const compat = value.__compat;
    const name = path.at(-1);
    if (compat) {
      // CSS function records live below types and property-specific grammars.
      if (path[1] === "types" || (path[1] === "properties" && path.length > 3)) {
        add(result.functions, name, path);
      }
      for (const support of Object.values(compat.support ?? {}))
        for (const statement of list(support)) {
          if (statement.alternative_name) add(result.aliases, statement.alternative_name, path);
          if (statement.prefix) add(result.aliases, statement.prefix + name, path);
        }
    }
    for (const [key, child] of Object.entries(value))
      if (key !== "__compat") visit(child, [...path, key]);
  }
  visit(bcd.css, ["css"]);
  catalogs.set(bcd, result);
  return result;
}

function partialApplies(statement, item) {
  if (!statement.partial_implementation) return true;
  const text = notes(statement);
  const context = item.context ?? {};
  // A note limiting a feature to SVG does not limit actual SVG declarations.
  if (/only.*SVG|SVG.*only|not.*HTML|HTML.*not supported/iu.test(text)) {
    return context.svg === true || context.namespace === "svg";
  }
  if (/only supported for inline elements/iu.test(text)) return context.inline === true;
  // Some value records encode the required property prefix in notes instead of prefix.
  if (/only supported with the -webkit- prefix/iu.test(text)) {
    return String(item.property ?? "").startsWith("-webkit-");
  }
  return false;
}

function evaluate(bcd, path, item, target) {
  const compat = at(bcd, path)?.__compat;
  if (!compat) return null;
  const requested = item.requestedName ?? path.at(-1);
  const canonical = path.at(-1);
  const engine = item.engine ?? "chrome";
  const statements = list(compat.support?.[engine]);
  const evidence = `${path.join(".")}.__compat.support.${engine}=${JSON.stringify(compat.support?.[engine] ?? null)}`;
  if (!statements.length) return { status: "unknown", evidence };
  let unknown = false;
  let selected;
  for (const statement of statements) {
    const spelling = statement.alternative_name ?? `${statement.prefix ?? ""}${canonical}`;
    if (spelling !== requested && !item.ignoreSpelling) continue;
    const added = versionNumber(statement.version_added);
    const removed = versionNumber(statement.version_removed);
    if (
      statement.version_added === null ||
      statement.version_added === true ||
      (added === null && statement.version_added !== false)
    )
      unknown = true;
    if (
      added === null ||
      added > target ||
      (removed !== null && removed <= target) ||
      statement.flags?.length
    )
      continue;
    if (!partialApplies(statement, item)) continue;
    selected = statement;
    break;
  }
  if (selected) return { status: "supported", evidence, version: String(selected.version_added) };
  return { status: unknown ? "unknown" : "unsupported", evidence };
}

function cssPaths(bcd, item) {
  const index = catalog(bcd);
  const feature = String(item.feature ?? "").replace(/^@/u, "");
  const property =
    item.property ??
    (item.kind === "css-value" ? feature.slice(0, feature.indexOf(":")) : undefined);
  const context = item.context ?? {};
  const containingRule = context.atRule ?? context.atRules?.[0] ?? "";
  const atRule = String(
    typeof containingRule === "object" ? containingRule.name : containingRule,
  ).replace(/^@/u, "");
  if (item.kind === "css-at-rule") return [["css", "at-rules", feature]];
  if (item.kind === "css-selector")
    return [
      ["css", "selectors", feature.replace(/^:+/u, "")],
      ...(index.aliases.get(feature.replace(/^:+/u, "")) ?? []),
    ];
  if (item.kind === "css-property") {
    const descriptors = atRule ? [["css", "at-rules", atRule, feature]] : [];
    // These descriptor names have no standalone CSS property interpretation.
    if (!atRule && ["src", "font-display", "unicode-range"].includes(feature))
      descriptors.push(["css", "at-rules", "font-face", feature]);
    return [...descriptors, ["css", "properties", feature], ...(index.aliases.get(feature) ?? [])];
  }
  if (item.kind === "css-value") {
    const value = feature.slice(feature.indexOf(":") + 1);
    const propertyPaths = [["css", "properties", property], ...(index.aliases.get(property) ?? [])];
    return propertyPaths.map((path) => [...path, value]);
  }
  if (item.kind === "css-function") {
    // rect() is two distinct grammars with different version histories.
    if (feature === "rect" && property === "clip") return [["css", "properties", "clip"]];
    if (feature === "format" && (property === "src" || atRule === "font-face"))
      return [["css", "at-rules", "font-face", "src"]];
    if (feature === "tech" && (property === "src" || atRule === "font-face"))
      return [["css", "at-rules", "font-face", "src", "tech_keyword"]];
    // BCD records the alpha aliases as the corresponding color function's alpha parameter.
    if (feature === "rgba" || feature === "hsla")
      return [["css", "types", "color", feature === "rgba" ? "rgb" : "hsl", "alpha_parameter"]];
    const paths = index.functions.get(feature) ?? [];
    const relevant = property
      ? paths.filter((path) => path[1] === "properties" && path[2] === property)
      : [];
    const types = paths.filter((path) => path[1] === "types");
    // Do not confuse a property keyword with a function when no grammar is known.
    const grammar = paths.filter(
      (path) =>
        ["grid-template-columns", "grid-template-rows"].includes(path[2]) &&
        ["minmax", "repeat", "fit-content"].includes(feature),
    );
    return [...relevant, ...types, ...grammar];
  }
  return [];
}
// Syntax-only scanning: escaped Tailwind class colons, quoted content and
// attribute values are not pseudo selectors or executable CSS functions.
// Parentheses remain visible so nested :is/:not/:has selectors are audited.
export function cssSyntaxNames(text, kind) {
  const names = [];
  let brackets = 0;
  const escape = (index) => {
    const hex = /^[\da-f]{1,6}/iu.exec(text.slice(index + 1))?.[0];
    if (!hex) return { end: Math.min(index + 2, text.length), value: text[index + 1] ?? "" };
    const code = Number.parseInt(hex, 16);
    let end = index + 1 + hex.length;
    if (/\s/u.test(text[end] ?? "")) {
      if (text[end] === "\r" && text[end + 1] === "\n") end++;
      end++;
    }
    return {
      end,
      value: String.fromCodePoint(code === 0 || code > 0x10ffff ? 0xfffd : code),
    };
  };
  const identifier = (start) => {
    let end = start;
    let value = "";
    while (end < text.length) {
      if (text[end] === "\\") {
        const escaped = escape(end);
        value += escaped.value;
        end = escaped.end;
      } else if (/[\w\u0080-\uffff-]/u.test(text[end])) value += text[end++];
      else break;
    }
    return { end, value };
  };
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (char === '"' || char === "'") {
      const quote = char;
      index++;
      while (index < text.length && text[index] !== quote)
        index = text[index] === "\\" ? escape(index).end : index + 1;
      index++;
    } else if (char === "\\") index = escape(index).end;
    else if (kind === "selector" && char === "[") { brackets++; index++; }
    else if (kind === "selector" && char === "]") { brackets--; index++; }
    else if (kind === "selector" && char === ":" && brackets === 0) {
      index += text[index + 1] === ":" ? 2 : 1;
      const token = identifier(index);
      if (token.value) names.push(token.value);
      index = token.end;
    } else if (kind === "function" && /[\w\u0080-\uffff-]/u.test(char)) {
      const token = identifier(index);
      if (text[token.end] === "(") {
        names.push(token.value.toLowerCase());
        // Unquoted URLs are opaque tokens, not nested function calls.
        if (token.value.toLowerCase() === "url") {
          index = token.end + 1;
          while (index < text.length && text[index] !== ")")
            index = text[index] === "\\" ? escape(index).end : index + 1;
          index++;
          continue;
        }
      }
      index = token.end;
    } else index++;
  }
  return names;
}

function otherEngineOnly(item, targetChrome, unavailable) {
  if (
    !["css-selector", "css-property"].includes(item.kind) ||
    !/^(?:-moz-|-ms-)/u.test(String(item.feature).replace(/^:+/u, ""))
  ) return null;
  const requestedName = String(item.feature).replace(/^:+/u, "");
  return {
    status: "other-engine-only",
    evidence: `${unavailable?.evidence ?? "No Chromium grammar record"}; ${requestedName} is a foreign-engine-only spelling ignored by Chrome ${targetChrome}, not a supported Chromium feature or a rendering-equivalence claim`,
  };
}


function equivalentImageRenderingFallback(bcd, item, targetChrome, unavailable) {
  if (
    item.kind !== "css-value" ||
    item.feature !== "image-rendering:crisp-edges" ||
    unavailable?.status !== "unsupported"
  )
    return null;
  // priorDecls is caller-owned syntax evidence from this exact containing rule,
  // in source order (also collected from generated CSS). Never search another
  // selector or assume an arbitrary earlier declaration has equivalent semantics.
  const prior = list(item.context?.priorDecls)
    .filter((declaration) => (declaration.property ?? declaration.prop) === "image-rendering")
    .at(-1);
  if (!prior || String(prior.value).trim() !== "pixelated") return null;
  const fallback = evaluate(
    bcd,
    ["css", "properties", "image-rendering", "pixelated"],
    { ...item, requestedName: "pixelated" },
    targetChrome,
  );
  if (fallback?.status !== "supported") return null;
  return {
    status: "supported",
    version: fallback.version,
    evidence: `${unavailable.evidence}; existing same-rule preceding image-rendering:pixelated remains effective when crisp-edges is rejected; preserves the source's nearest-neighbor raster rendering policy (not a generic CSS fallback equivalence). ${fallback.evidence}`,
  };
}

/** Metadata availability, with narrowly proven same-rule equivalent CSS fallbacks. */
export function lookupBrowserSupport(bcd, item, targetChrome = 120) {
  if (!String(item.kind ?? "").startsWith("css-"))
    return { status: "unknown", evidence: "This lookup covers CSS grammar only" };
  const feature = String(item.feature ?? "").replace(/^@/u, "");
  if (
    item.kind === "css-function" &&
    ["theme", "--alpha", "--spacing"].includes(feature)
  ) {
    return {
      status: "build-directive",
      evidence: `Tailwind CSS build-time function ${feature}(); https://tailwindcss.com/docs/functions-and-directives#functions and #theme-function (must not survive in generated runtime CSS)`,
    };
  }
  if (
    item.kind === "css-at-rule" &&
    [
      "theme",
      "source",
      "plugin",
      "custom-variant",
      "utility",
      "variant",
      "apply",
      "reference",
      "config",
    ].includes(feature)
  ) {
    return {
      status: "build-directive",
      evidence: `Tailwind CSS compiler directive @${feature}; https://tailwindcss.com/docs/functions-and-directives (not a browser runtime API)`,
    };
  }
  if (item.kind === "css-property" && ["app-region", "-webkit-app-region"].includes(feature)) {
    return {
      status: "supported",
      version: "28",
      evidence:
        "Electron 28 frameless-window draggable region CSS app-region/-webkit-app-region: https://github.com/electron/electron/blob/v28.3.3/docs/api/frameless-window.md#draggable-region",
    };
  }
  const paths = cssPaths(bcd, item);
  let unresolved;
  for (const path of paths) {
    const canonical = path.at(-1);
    // Functions and inherited members use the resolved grammar's spelling; vendor
    // properties/selectors must match the actual support statement's spelling.
    const requestedName =
      ["css-property", "css-selector"].includes(item.kind)
        ? feature.replace(/^:+/u, "")
        : canonical;
    const result = evaluate(bcd, path, { ...item, requestedName }, targetChrome);
    if (!result) continue;
    if (result.status === "supported" || result.status === "other-engine-only") return result;
    unresolved ??= result;
  }
  const ignoredVendor = otherEngineOnly(item, targetChrome, unresolved);
  if (ignoredVendor) return ignoredVendor;
  const equivalentFallback = equivalentImageRenderingFallback(bcd, item, targetChrome, unresolved);
  if (equivalentFallback) return equivalentFallback;
  return (
    unresolved ?? {
      status: "unknown",
      evidence: `No exact pinned BCD record for ${item.symbol ?? item.feature ?? "(unnamed feature)"}; searched ${paths.map((path) => path.join(".")).join(", ")}`,
    }
  );
}
