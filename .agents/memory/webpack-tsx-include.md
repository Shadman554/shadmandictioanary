---
name: webpack tsx include pattern
description: How to make babel-loader process all project .tsx/.ts files without listing each one explicitly
---

Use `exclude: /node_modules/` on the source-files rule instead of listing individual file paths in `include`.
Then add a SEPARATE rule with an explicit `include` array for the node_modules packages that need transpilation (react-native-web, @react-native, etc.).

**Why:** The per-file `include` list breaks HMR — when webpack processes an HMR update it re-evaluates imports from scratch, and a newly-added file (e.g. Icons.tsx) may not be in the cached include list even though it was in the config. Using `exclude: /node_modules/` is always safe for the source rule.

**How to apply:** Every new .tsx file in the project root is automatically transpiled. Only touch the node_modules `include` list when adding a new RN library that ships untranspiled ESM.
