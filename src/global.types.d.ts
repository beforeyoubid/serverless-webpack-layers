declare module 'is-builtin-module' {
  function isBuiltinModule(module: string): boolean;
  export default isBuiltinModule;
}

declare module 'minify-all-js' {
  interface Options {
    compress_json?: boolean;
    module?: boolean;
    mangle?: boolean;
    packagejson?: boolean;
  }
  function minifyAll(layerPath: string, options: Options): Promise<void>;
  export default minifyAll;
}
