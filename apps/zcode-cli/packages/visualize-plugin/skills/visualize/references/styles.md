# Runtime style reference

Read [the complete skill](../SKILL.md) for the styling rules and class catalog. The host injects [visualize.css](../assets/visualize.css); the standalone export uses the same stylesheet. No separate style guide overrides those rules.

The shared stylesheet includes a capability-guarded fallback for browsers without `light-dark()` (including Chromium 120). Its existing semantic tokens, chart palette, and carousel chrome follow the host's explicit `data-theme="light"` / `"dark"` appearance, or the system color preference in standalone documents without an explicit theme. Host-injected color tokens still take precedence. Browsers supporting `light-dark()` continue using the original declarations. This fallback covers the bundled stylesheet, not arbitrary author-provided CSS or JavaScript.
