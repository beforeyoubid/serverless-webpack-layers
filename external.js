const webpack = require('webpack');
const path = require('path');
const fs = require('fs');
const isBuiltinModule = require('is-builtin-module');

global['PACKAGING_LABELS'] = true

const compile = file => new Promise((resolve, reject) => webpack(file).run((err, stats) => err ? reject(err) : resolve(stats)));

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

function resolvedEntries(sls, layerRefName){
  const newEntries = {};
  const { backupFileType } = sls.service.custom.layerConfig;
  for (const func of Object.values(sls.service.functions)) {
    const { handler, layers } = func;
    if (!layers.some(layer => layer.Ref === layerRefName)) continue;
    const match = handler.match(/^(((?:[^\/\n]+\/)+)[^.]+(.jsx?|.tsx?)?)/);
    if (!match) continue;
    const [handlerName, _, folderName] = match;
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

async function getExternalModules(sls, layerRefName) {
  try {
    const runPath = process.cwd();
    const { webpack: webpackConfig } = sls.service.custom.layerConfig;
    const { configPath = '', entries = [], forceInclude = [], forceExclude = [] } = webpackConfig;
    const config = await require(path.join(runPath, configPath));
    config.entry = resolvedEntries(sls, layerRefName);
    const stats = await compile(config)
    const packageJson = await require(path.join(runPath, 'package.json'));
    const moduleNames = new Set(getExternalModulesFromStats(stats).map(({ name }) => name));
    forceInclude.forEach(forceIncludedModule => moduleNames.add(forceIncludedModule));
    forceExclude.forEach(forceExcludedModule => moduleNames.delete(forceExcludedModule));
    return Array.from(moduleNames).map(name => packageJson.dependencies[name] ?
      `${name}@${packageJson.dependencies[name]}`
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