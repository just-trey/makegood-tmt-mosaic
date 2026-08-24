// jsdom's published typings track the library's own major, and there is no @types/jsdom for the
// 29.x this repo runs: the registry jumps 28 -> 30. Carrying either would mean shipping typings a
// major away from the runtime to describe the two lines of jsdom the benches touch.
//
// So they are declared here instead, the same way src/turf.d.ts and src/polygon-clipping.d.ts
// handle their packages. Widen this only when a bench actually needs more of the surface.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
