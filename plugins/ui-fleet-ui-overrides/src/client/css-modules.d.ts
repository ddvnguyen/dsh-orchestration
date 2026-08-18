/**
 * CSS-module type support for the plugin (mirrors ui-fleet-sidebar and the
 * DSH monorepo convention): `*.module.css` imports resolve to the hashed
 * class map instead of failing the type check.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
