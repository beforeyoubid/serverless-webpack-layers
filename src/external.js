const webpack = require('webpack');
const path = require('path');
const fs = require('fs');
const isBuiltinModule = require('is-builtin-module');
const glob = require('glob');

global['PACKAGING_LABELS'] = true

const compile = file => new Promise((resolve, reject) => webpack(file).run((err, stats) => err ? reject(err) : resolve(stats)));

const defaultWebpackConfig = {
  clean: true,
  backupFileType: 'js',
  configPath: './webpack.config.js',
  discoverModules: true,
  forceInclude: [],
  forceExclude: [],
};

function isExternalModule(module) {
  return module.identifier().startsWith('external ') && !isBuiltinModule(getExternalModuleName(module));
}

function getExternalModuleName(module) {
  const path = /^external "(.*)"$/.exec(module.identifier())[1];
  const pathComponents = path.split('/');
  const main = pathComponents[0];

  // this is a package within a namespace
  if (main.charAt(0) == '@') {
    return `${main}/${pathComponents[1]}`;
  }

  return main;
}

function getExternalModulesFromStats(stats) {
  if (!stats.compilation.chunks) {
    return [];
  }
  const externals = new Set();
  for (const chunk of stats.compilation.chunks) {
    if (!chunk.modulesIterable) {
      continue;
    }

    // Explore each module within the chunk (built inputs):
    for (const module of chunk.modulesIterable) {
      if (isExternalModule(module)) {
        externals.add({
          name: getExternalModuleName(module)
        });
      }
    }
  }
  return Array.from(externals);
}

const globPromise = pattern => new Promise((resolve, reject) => glob(pattern, (err, matches) => err ? reject(err) : resolve(matches)));

async function findEntriesSpecified(specifiedEntries) {
  let entries = specifiedEntries;
  if (typeof specifiedEntries === 'string') {
    entries = [specifiedEntries];
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  const allMapped = await Promise.all(entries.map(globPromise));
  return allMapped.reduce((arr, list) => arr.concat(list), [])
}

async function resolvedEntries(sls, layerRefName){
  const newEntries = {};
  const { backupFileType } = sls.service.custom.layerConfig;
  for (const func of Object.values(sls.service.functions)) {
    const { handler, layers = [], entry: specifiedEntries = [], shouldLayer = true } = func;
    if (!shouldLayer) return false;
    if (!layers.some(layer => layer.Ref === layerRefName)) continue;
    const matchedSpecifiedEntries = await findEntriesSpecified(specifiedEntries);
    for (const entry of matchedSpecifiedEntries) {
      newEntries[entry] = path.resolve(entry);
    }
    const match = handler.match(/^(((?:[^\/\n]+\/)+)?[^.]+(.jsx?|.tsx?)?)/);
    if (!match) continue;
    const [handlerName, _, folderName = ''] = match;
    const files = fs.readdirSync(path.resolve(folderName.replace(/\/$/, '')));
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
function getForceModulesFromFunctions(sls, layerRefName){
  let forceIncludeAll = [];
  let forceExcludeAll = [];
  for (const func of Object.values(sls.service.functions)) {
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

async function getExternalModules(sls, layerRefName) {
  try {
    const runPath = process.cwd();
    const { webpack: webpackConfigUnmerged = {} } = sls.service.custom.layerConfig;
    const webpackConfig = merge(defaultWebpackConfig, webpackConfigUnmerged);
    let forceInclude = [
      ...defaultWebpackConfig.forceInclude,
      ...(webpackConfigUnmerged ? webpackConfigUnmerged.forceInclude || {} : {}),
    ]
    let forceExclude = [
      ...defaultWebpackConfig.forceExclude,
      ...(webpackConfigUnmerged ? webpackConfigUnmerged.forceExclude || {} : {}),
    ]
    const { configPath = './webpack.config.js', discoverModules = true } = webpackConfig;
    let config = await require(path.join(runPath, configPath));
    if (typeof config === 'function') {
      let newConfigValue = config();
      if (newConfigValue instanceof Promise) {
        newConfigValue = await newConfigValue;
      }
      config = newConfigValue;
    }
    const { forceInclude: forceIncludeFunction = [], forceExclude: forceExcludeFunction = [] } = getForceModulesFromFunctions(sls, layerRefName);
    config.entry = await resolvedEntries(sls, layerRefName);
    const packageJson = await require(path.join(runPath, 'package.json'));
    let moduleNames = [];
    if (discoverModules) {
      const stats = await compile(config)
      moduleNames = new Set(getExternalModulesFromStats(stats).map(({ name }) => name));
    }
    forceInclude.concat(forceIncludeFunction).forEach(forceIncludedModule => moduleNames.add(forceIncludedModule));
    forceExclude.concat(forceExcludeFunction).forEach(forceExcludedModule => moduleNames.delete(forceExcludedModule));
    return Array.from(moduleNames).map(name => packageJson.dependencies[name] || packageJson.devDependencies[name] ?
      `${name}@${packageJson.dependencies[name] || packageJson.devDependencies[name]}`
      : name
    );
  } catch (err) {
    console.error(err);
    throw err;
  }
}

module.exports = {
  getExternalModules
};