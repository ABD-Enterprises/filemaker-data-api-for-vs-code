// axios exposes its NO_PROXY matcher under "unsafe/*"; it has no type declarations.
declare module 'axios/unsafe/helpers/shouldBypassProxy.js' {
  export default function shouldBypassProxy(location: string): boolean;
}
