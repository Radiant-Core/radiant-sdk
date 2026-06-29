/**
 * Minimal ambient declaration for `@radiant-core/radiantjs`.
 *
 * radiantjs is a CommonJS bundle (a fork of bitcore-lib for Radiant) that
 * attaches its classes onto a single exported object. It does not ship rich
 * TypeScript types for the methods we use, so we declare the default export as
 * `any` and centralise all access through `src/radiantjs.ts`. This keeps the
 * SDK's *public* surface strongly typed while letting the low-level wrapping
 * code talk to radiantjs without fighting its loose runtime shapes.
 */
declare module "@radiant-core/radiantjs" {
  const radiantjs: any;
  export default radiantjs;
}
