import type * as ts from 'typescript';
import type * as swcWasm from '@swc/wasm';
import type * as swcTypes from '@swc/core';
import type { CreateTranspilerOptions, Transpiler } from './types';
import type { NodeModuleEmitKind } from '..';

type SwcInstance = typeof swcWasm;
export interface SwcTranspilerOptions extends CreateTranspilerOptions {
  /**
   * swc compiler to use for compilation
   * Set to '@swc/wasm' to use swc's WASM compiler
   * Default: '@swc/core', falling back to '@swc/wasm'
   */
  swc?: string | typeof swcWasm;
}

export function create(createOptions: SwcTranspilerOptions): Transpiler {
  const {
    swc,
    service: { config, projectLocalResolveHelper },
    transpilerConfigLocalResolveHelper,
    nodeModuleEmitKind,
  } = createOptions;

  // Load swc compiler
  let swcInstance: SwcInstance;
  // Used later in diagnostics; merely needs to be human-readable.
  let swcDepName: string = 'swc';
  if (typeof swc === 'string') {
    swcDepName = swc;
    swcInstance = require(transpilerConfigLocalResolveHelper(
      swc,
      true
    )) as typeof swcWasm;
  } else if (swc == null) {
    let swcResolved;
    try {
      swcDepName = '@swc/core';
      swcResolved = transpilerConfigLocalResolveHelper(swcDepName, true);
    } catch (e) {
      try {
        swcDepName = '@swc/wasm';
        swcResolved = transpilerConfigLocalResolveHelper(swcDepName, true);
      } catch (e) {
        throw new Error(
          'swc compiler requires either @swc/core or @swc/wasm to be installed as a dependency.  See https://typestrong.org/ts-node/docs/transpilers'
        );
      }
    }
    swcInstance = require(swcResolved) as typeof swcWasm;
  } else {
    swcInstance = swc;
  }

  // Prepare SWC options derived from typescript compiler options
  const { nonTsxOptions, tsxOptions } = createSwcOptions(
    config.options,
    nodeModuleEmitKind,
    swcInstance,
    swcDepName
  );

  const transpile: Transpiler['transpile'] = (input, transpileOptions) => {
    const { fileName } = transpileOptions;
    const swcOptions =
      fileName.endsWith('.tsx') || fileName.endsWith('.jsx')
        ? tsxOptions
        : nonTsxOptions;

    //@ts-expect-error
    const { code, map } = swcInstance.transformSync(input, {
      ...swcOptions,
      filename: fileName,
    });
    return { outputText: code, sourceMapText: map };
  };

  return {
    transpile,
  };
}

/** @internal */
export const targetMapping = new Map<ts.ScriptTarget, SwcTarget>();
targetMapping.set(/* ts.ScriptTarget.ES3 */ 0, 'es3');
targetMapping.set(/* ts.ScriptTarget.ES5 */ 1, 'es5');
targetMapping.set(/* ts.ScriptTarget.ES2015 */ 2, 'es2015');
targetMapping.set(/* ts.ScriptTarget.ES2016 */ 3, 'es2016');
targetMapping.set(/* ts.ScriptTarget.ES2017 */ 4, 'es2017');
targetMapping.set(/* ts.ScriptTarget.ES2018 */ 5, 'es2018');
targetMapping.set(/* ts.ScriptTarget.ES2019 */ 6, 'es2019');
targetMapping.set(/* ts.ScriptTarget.ES2020 */ 7, 'es2020');
targetMapping.set(/* ts.ScriptTarget.ES2021 */ 8, 'es2021');
targetMapping.set(/* ts.ScriptTarget.ES2022 */ 9, 'es2022');
targetMapping.set(/* ts.ScriptTarget.ESNext */ 99, 'esnext');

type SwcTarget = typeof swcTargets[number];
/**
 * @internal
 * We use this list to downgrade to a prior target when we probe swc to detect if it supports a particular target
 */
const swcTargets = [
  'es3',
  'es5',
  'es2015',
  'es2016',
  'es2017',
  'es2018',
  'es2019',
  'es2020',
  'es2021',
  'es2022',
  'esnext',
] as const;

const ModuleKind = {
  None: 0,
  CommonJS: 1,
  AMD: 2,
  UMD: 3,
  System: 4,
  ES2015: 5,
  ES2020: 6,
  ESNext: 99,
  Node16: 100,
  NodeNext: 199,
} as const;

const JsxEmit = {
  ReactJSX: /* ts.JsxEmit.ReactJSX */ 4,
  ReactJSXDev: /* ts.JsxEmit.ReactJSXDev */ 5,
} as const;

/**
 * Prepare SWC options derived from typescript compiler options.
 * @internal exported for testing
 */
export function createSwcOptions(
  compilerOptions: ts.CompilerOptions,
  nodeModuleEmitKind: NodeModuleEmitKind | undefined,
  swcInstance: SwcInstance,
  swcDepName: string
) {
  const {
    esModuleInterop,
    sourceMap,
    importHelpers,
    experimentalDecorators,
    emitDecoratorMetadata,
    target,
    module,
    jsx,
    jsxFactory,
    jsxFragmentFactory,
    strict,
    alwaysStrict,
    noImplicitUseStrict,
  } = compilerOptions;

  let swcTarget = targetMapping.get(target!) ?? 'es3';
  // Downgrade to lower target if swc does not support the selected target.
  // Perhaps project has an older version of swc.
  // TODO cache the results of this; slightly faster
  let swcTargetIndex = swcTargets.indexOf(swcTarget);
  for (; swcTargetIndex >= 0; swcTargetIndex--) {
    try {
      swcInstance.transformSync('', {
        jsc: { target: swcTargets[swcTargetIndex] as swcWasm.JscTarget },
      });
      break;
    } catch (e) {}
  }
  swcTarget = swcTargets[swcTargetIndex];
  const keepClassNames = target! >= /* ts.ScriptTarget.ES2016 */ 3;
  const isNodeModuleKind =
    module === ModuleKind.Node16 || module === ModuleKind.NodeNext;
  // swc only supports these 4x module options [MUST_UPDATE_FOR_NEW_MODULEKIND]
  const moduleType =
    module === ModuleKind.CommonJS
      ? 'commonjs'
      : module === ModuleKind.AMD
      ? 'amd'
      : module === ModuleKind.UMD
      ? 'umd'
      : isNodeModuleKind && nodeModuleEmitKind === 'nodecjs'
      ? 'commonjs'
      : isNodeModuleKind && nodeModuleEmitKind === 'nodeesm'
      ? 'es6'
      : 'es6';
  // In swc:
  //   strictMode means `"use strict"` is *always* emitted for non-ES module, *never* for ES module where it is assumed it can be omitted.
  //   (this assumption is invalid, but that's the way swc behaves)
  // tsc is a bit more complex:
  //   alwaysStrict will force emitting it always unless `import`/`export` syntax is emitted which implies it per the JS spec.
  //   if not alwaysStrict, will emit implicitly whenever module target is non-ES *and* transformed module syntax is emitted.
  // For node, best option is to assume that all scripts are modules (commonjs or esm) and thus should get tsc's implicit strict behavior.

  // Always set strictMode, *unless* alwaysStrict is disabled and noImplicitUseStrict is enabled
  const strictMode =
    // if `alwaysStrict` is disabled, remembering that `strict` defaults `alwaysStrict` to true
    (alwaysStrict === false || (alwaysStrict !== true && strict !== true)) &&
    // if noImplicitUseStrict is enabled
    noImplicitUseStrict === true
      ? false
      : true;

  const jsxRuntime: swcTypes.ReactConfig['runtime'] =
    jsx === JsxEmit.ReactJSX || jsx === JsxEmit.ReactJSXDev
      ? 'automatic'
      : undefined;
  const jsxDevelopment: swcTypes.ReactConfig['development'] =
    jsx === JsxEmit.ReactJSXDev ? true : undefined;

  const nonTsxOptions = createVariant(false);
  const tsxOptions = createVariant(true);
  return { nonTsxOptions, tsxOptions };

  function createVariant(isTsx: boolean): swcTypes.Options {
    const swcOptions: swcTypes.Options = {
      sourceMaps: sourceMap,
      // isModule: true,
      module: moduleType
        ? {
            noInterop: !esModuleInterop,
            type: moduleType,
            strictMode,
            // For NodeNext and Node12, emit as CJS but do not transform dynamic imports
            ignoreDynamic: nodeModuleEmitKind === 'nodecjs',
          }
        : undefined,
      swcrc: false,
      jsc: {
        externalHelpers: importHelpers,
        parser: {
          syntax: 'typescript',
          tsx: isTsx,
          decorators: experimentalDecorators,
          dynamicImport: true,
          importAssertions: true,
        } as swcWasm.TsParserConfig,
        target: swcTarget as swcWasm.JscTarget,
        transform: {
          decoratorMetadata: emitDecoratorMetadata,
          legacyDecorator: true,
          react: {
            throwIfNamespace: false,
            development: jsxDevelopment,
            useBuiltins: false,
            pragma: jsxFactory!,
            pragmaFrag: jsxFragmentFactory!,
            runtime: jsxRuntime,
          },
        },
        keepClassNames,
        experimental: {
          keepImportAssertions: true,
        },
      },
    };

    // Throw a helpful error if swc version is old, for example, if it rejects `ignoreDynamic`
    try {
      //@ts-expect-error
      swcInstance.transformSync('', swcOptions);
    } catch (e) {
      throw new Error(
        `${swcDepName} threw an error when attempting to validate swc compiler options.\n` +
          'You may be using an old version of swc which does not support the options used by ts-node.\n' +
          'Try upgrading to the latest version of swc.\n' +
          'Error message from swc:\n' +
          (e as Error)?.message
      );
    }

    return swcOptions;
  }
}
