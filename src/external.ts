import webpack, { ExternalModule } from 'webpack';
import merge from 'lodash.merge';
import path from 'path';
import fs from 'fs';
import glob from 'glob';
import Serverless from 'serverless';
import isBuiltinModule from 'is-builtin-module';
import { Stats, Module } from 'webpack';
import { isFunctionDefinition, Maybe } from './types';

declare const global: CustomGlobal;

global['PACKAGING_LABELS'] = true;

const compile = (file: webpack.Configuration): Promise<Maybe<Stats>> =>
  new Promise((resolve, reject) =>
    webpack(file).run((err?: Error, stats?: Stats) => (err ? reject(err) : resolve(stats)))
  );

const defaultWebpackConfig = {
  clean: true,
  backupFileType: 'js',
  configPath: './webpack.config.js',
  discoverModules: true,
  forceInclude: [],
  forceExclude: [],
};

function isExternalModule(module: Module): module is ExternalModule {
  return Object.prototype.hasOwnProperty.call(module, 'externalType');
}

function getExternalModuleName(module: ExternalModule): string {
  const regex = module.externalType ? new RegExp(`^external ${module.externalType} "(.*)"$`) : /^external "(.*)"$/;
  const pathParts = regex.exec(
    typeof module.identifier === 'function' ? module.identifier() : (module.identifier as unknown as string)
  );
  if (pathParts === null) return '';
  const modulePath = pathParts[1];
  const pathComponents = modulePath.split('/');
  const main = pathComponents[0];

  // this is a package within a namespace
  if (main.charAt(0) == '@') {
    return `${main}/${pathComponents[1]}`;
  }

  return main.replace('external', '').replace(module.externalType, '').replace(/"/g, '').trim();
}

function getExternalModulesFromStats(stats: Maybe<Stats>): string[] {
  if (!stats || !stats.compilation.chunks) {
    return [];
  }
  const externals: Set<string> = new Set();
  for (const chunk of stats.compilation.chunks) {
    const modules = stats.compilation.chunkGraph.getChunkModules(chunk);

    // Explore each module within the chunk (built inputs):
    for (const module of modules) {
      if (isExternalModule(module)) {
        if (isBuiltinModule(getExternalModuleName(module))) continue;
        const externalModuleName = getExternalModuleName(module);
        if (externalModuleName === undefined) continue;
        externals.add(externalModuleName);
      }
    }
  }
  return Array.from(externals);
}

const globPromise = (pattern: string): Promise<string[]> =>
  new Promise((resolve, reject) => glob(pattern, (err, matches) => (err ? reject(err) : resolve(matches))));

async function findEntriesSpecified(specifiedEntries: string | string[]) {
  let entries = specifiedEntries;
  if (typeof specifiedEntries === 'string') {
    entries = [specifiedEntries];
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  const allMapped = await Promise.all(entries.map(globPromise));
  return allMapped.reduce((arr, list) => arr.concat(list), []);
}

async function resolvedEntries(sls: Serverless, layerRefName: string) {
  const newEntries: Record<string, string> = {};
  const backupFileType =
    sls.service.custom.layerConfig.backupFileType ?? sls.service.custom.layerConfig.webpack.backupFileType ?? 'default';
  for (const func of Object.values(sls.service.functions)) {
    if (!isFunctionDefinition(func)) {
      console.error(`This library doesn't currently support functions with an image`);
      continue;
    }
    const { handler, layers = [], entry: specifiedEntries = [], shouldLayer = true } = func;
    if (!shouldLayer) continue;
    if (!layers.some(layer => layer.Ref === layerRefName)) continue;
    const matchedSpecifiedEntries = await findEntriesSpecified(specifiedEntries);
    for (const entry of matchedSpecifiedEntries) {
      newEntries[entry] = path.resolve(entry);
    }
    const match = handler.match(/^(((?:[^\/\n]+\/)+)?[^.]+(.jsx?|.tsx?)?)/);
    if (!match) continue;
    const [handlerName, , folderName = ''] = match;
    const files = await fs.promises.readdir(path.resolve(folderName.replace(/\/$/, '')));
    let fileName = handlerName.replace(folderName, '');
    const filteredFiles = files.filter(file => file.startsWith(fileName));
    if (filteredFiles.length > 1) {
      fileName += `.${backupFileType}`;
    } else {
      fileName = filteredFiles[0];
    }
    newEntries[handlerName] = path.resolve(path.join(folderName, fileName));
  }
  return newEntries;
}
function getForceModulesFromFunctions(sls: Serverless, layerRefName: string) {
  let forceIncludeAll: string[] = [];
  let forceExcludeAll: string[] = [];
  for (const func of Object.values(sls.service.functions)) {
    if (!isFunctionDefinition(func)) {
      console.error(`This library doesn't currently support functions with an image`);
      continue;
    }
    const { layers = [], forceInclude = [], forceExclude = [] } = func;
    if (!layers.some(layer => layer.Ref === layerRefName)) continue;
    forceIncludeAll = forceIncludeAll.concat(forceInclude);
    forceExcludeAll = forceIncludeAll.concat(forceExclude);
  }
  return {
    forceInclude: forceIncludeAll,
    forceExclude: forceExcludeAll,
  };
}

type WebpackConfigAsObjOrFunc =
  | webpack.Configuration
  | (() => webpack.Configuration)
  | (() => Promise<webpack.Configuration>);

export async function getExternalModules(sls: Serverless, layerRefName: string): Promise<string[]> {
  try {
    const runPath = process.cwd();
    const { webpack: webpackConfigUnmerged = {} } = sls.service.custom.layerConfig;
    const webpackConfig = merge(defaultWebpackConfig, webpackConfigUnmerged);
    const forceInclude = [
      ...webpackConfig.forceInclude,
      ...(Array.isArray(webpackConfigUnmerged.forceInclude) ? webpackConfigUnmerged.forceInclude : []),
    ];
    const forceExclude = [
      ...webpackConfig.forceExclude,
      ...(Array.isArray(webpackConfigUnmerged.forceExclude) ? webpackConfigUnmerged.forceExclude : []),
    ];
    const { configPath = './webpack.config.js', discoverModules = true } = webpackConfig;
    let config: WebpackConfigAsObjOrFunc = await require(path.join(runPath, configPath));
    if (typeof config === 'function') {
      let newConfigValue = config();
      if (newConfigValue instanceof Promise) {
        newConfigValue = await newConfigValue;
      }
      config = newConfigValue;
    }
    const { forceInclude: forceIncludeFunction = [], forceExclude: forceExcludeFunction = [] } =
      getForceModulesFromFunctions(sls, layerRefName);
    config.entry = await resolvedEntries(sls, layerRefName);
    const packageJson = await require(path.join(runPath, 'package.json'));
    let moduleNames: Set<string> = new Set();
    if (discoverModules) {
      const stats = await compile(config);
      moduleNames = new Set(getExternalModulesFromStats(stats));
    }
    forceInclude.concat(forceIncludeFunction).forEach(forceIncludedModule => moduleNames.add(forceIncludedModule));
    forceExclude.concat(forceExcludeFunction).forEach(forceExcludedModule => moduleNames.delete(forceExcludedModule));
    return Array.from(moduleNames).map(name =>
      packageJson.dependencies[name] || packageJson.devDependencies[name]
        ? `${name}@${packageJson.dependencies[name] || packageJson.devDependencies[name]}`
        : name
    );
  } catch (err) {
    console.error(err);
    throw err;
  }
}
