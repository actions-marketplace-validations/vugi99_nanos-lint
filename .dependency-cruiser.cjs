/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "No circular dependencies anywhere in src/ or tests/.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-duplicate-dep-specs",
      severity: "error",
      comment:
        "Forbid duplicate dependency specifications or duplicate imports of the same module within a single file or package.json.",
      from: {},
      to: {
        moreThanOneDependencyType: true,
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "no-deprecated-npm",
      severity: "warn",
      comment: "Emit a warning if any imported dependency is marked deprecated on npm.",
      from: {},
      to: {
        dependencyTypes: ["deprecated"],
      },
    },
    {
      name: "no-src-to-tests",
      severity: "error",
      comment: "Modules in src/ must never import anything from tests/.",
      from: {
        path: "^src/",
      },
      to: {
        path: "^tests/",
      },
    },
    {
      name: "not-to-spec",
      severity: "error",
      comment: "Modules in src/ must never import spec or test files.",
      from: {
        path: "^src/",
      },
      to: {
        path: "[.](?:spec|test)[.](?:js|mjs|cjs|ts|mts|cts)$",
      },
    },
    {
      name: "tsdown-bundle-boundary",
      severity: "error",
      comment:
        "Modules in src/ must only import Node built-ins or whitelisted bundled packages (commander, jsonc-parser, env-paths, glob) and never dev tooling. (Transitive runtime dependencies are inlined by tsdown per tsdown.config.ts alwaysBundle).",
      from: {
        path: "^src/",
      },
      to: {
        dependencyTypes: ["npm", "npm-dev"],
        pathNot: [
          "^node_modules/(?:commander|jsonc-parser|env-paths|glob)(?:/|$)",
          "^node_modules/@types/",
        ],
      },
    },
    {
      name: "no-unlisted-deps",
      severity: "error",
      comment:
        "Any external package imported anywhere in the repo must be explicitly declared in package.json.",
      from: {},
      to: {
        dependencyTypes: ["npm-no-pkg", "npm-unknown"],
      },
    },
    {
      name: "no-orphans",
      severity: "error",
      comment:
        "Source files in src/ must be imported by at least one other module, with explicit exceptions for defined entry points (src/index.ts and src/cli.ts).",
      from: {
        orphan: true,
        path: "^src/",
        pathNot: ["^src/index\\.ts$", "^src/cli\\.ts$", "\\.d\\.(c|m)?ts$"],
      },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Forbid imports pointing to unresolvable paths or missing files.",
      from: {},
      to: {
        couldNotResolve: true,
      },
    },
    {
      name: "permissive-license-only",
      severity: "error",
      comment:
        "Restrict imported production and direct dev dependencies to an approved permissive license whitelist compatible with MIT (MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0) and forbid copyleft, viral, or non-commercial licenses.",
      from: {},
      to: {
        dependencyTypes: ["npm", "npm-dev"],
        licenseNot:
          "^(?:MIT|ISC|Apache-2\\.0|BSD-2-Clause|BSD-3-Clause|0BSD|Unlicense|CC0-1\\.0|BlueOak-1\\.0\\.0)$",
      },
    },
    {
      name: "architectural-layering-reporter",
      severity: "error",
      comment:
        "src/reporter.ts must not import execution runners (src/luals/runner.ts, src/luals/download.ts).",
      from: {
        path: "^src/reporter\\.ts$",
      },
      to: {
        path: "^src/luals/(?:runner|download)\\.ts$",
      },
    },
    {
      name: "architectural-layering-foundations",
      severity: "error",
      comment:
        "Foundational modules (src/types.ts, src/errors.ts, src/logger.ts, src/paths.ts) must not import src/cli.ts or src/luals/runner.ts.",
      from: {
        path: "^src/(?:types|errors|logger|paths)\\.ts$",
      },
      to: {
        path: "^src/(?:cli|luals/runner)\\.ts$",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: "specify",
    tsConfig: {
      fileName: "./tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
