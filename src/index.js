const {
  LOG_LEVEL = 'info'
} = process.env;

const {execSync} = require('child_process');
const pascalcase = require('pascalcase');
const fs = require('fs');
const path = require('path');
const del = require('del');
const { getExternalModules } = require('./external');

const DEFAULT_CONFIG = {
  installLayers: true,
  exportLayers: true,
  upgradeLayerReferences: true,
  exportPrefix: '${AWS::StackName}-',
  manageNodeFolder: false,
  packager: 'npm',
  webpack: {
    clean: true,
    backupFileType: 'js',
    configPath: './webpack.config.js'
  },
};

const LEVELS = {
  none: 0,
  info: 1,
  verbose: 2
};

function log(...s) {
  console.log('[layer-manager]', ...s);
}

function verbose({level}, ...s) {
  LEVELS[level] >= LEVELS.verbose && log(...s);
}

function info({level}, ...s) {
  LEVELS[level] >= LEVELS.info && log(...s);
}

function getLayers(serverless) {
  return serverless.service.layers || {};
}

function getConfig(serverless) {
  const custom = serverless.service.custom || {};

  return {...DEFAULT_CONFIG, ...custom.layerConfig};
}

class LayerManagerPlugin {
  constructor(sls, options = {}) {
    this.level = options.v || options.verbose ? 'verbose' : LOG_LEVEL;

    info(this, `Invoking layer-manager plugin`);

    this.hooks = {
      'package:initialize': () => {
        this.init(sls);
        return this.installLayers(sls)
      },
      'before:deploy:deploy': () => this.transformLayerResources(sls),
    };
  }

  init(sls) {
    this.config = getConfig(sls);
    verbose(this, `Config: `, this.config);
  }

  async installLayer(sls, layer, layerName) {
    const { path: localPath } = layer;
    const layerRefName = `${layerName.replace(/^./, x => x.toUpperCase())}LambdaLayer`;
    const nodeLayerPath = `${localPath}/nodejs`;
    if (!this.config.manageNodeFolder && !fs.existsSync(nodeLayerPath)) {
      return false;
    }
    if (this.config.manageNodeFolder) {
      await del(`${nodeLayerPath}/**`);
    }

    if (!fs.existsSync(nodeLayerPath) && this.config.manageNodeFolder) {
      fs.mkdirSync(nodeLayerPath);
    }
    if (!this.config.webpack) {
      fs.copyFileSync(
        path.join(process.cwd(), 'package.json'),
        path.join(nodeLayerPath, 'package.json')
      );
      if (this.config.packager === 'npm') {
        fs.copyFileSync(
          path.join(process.cwd(), 'package-lock.json'),
          path.join(nodeLayerPath, 'package-lock.json')
        );
      } else if (this.config.packager === 'yarn') {
        fs.copyFileSync(
          path.join(process.cwd(), 'yarn.lock'),
          path.join(nodeLayerPath, 'yarn.lock')
        );
      }
    } else if (this.config.manageNodeFolder) {
      fs.writeFileSync(path.join(nodeLayerPath, 'package.json'), '{}');
    }
    verbose(this, `Installing nodejs layer ${localPath} with ${this.config.packager}`);
    let command = this.config.packager === 'npm'
      ? 'npm install'
      : 'yarn install';
    if (this.config.webpack) {
      const packages = await getExternalModules(sls, layerRefName);
      command = this.config.packager === 'npm'
        ? `npm install ${packages.join(' ')}`
        : `yarn add ${packages.join(' ')}`;
    }
    info(this, `Running command ${command}`);
    execSync(command, {
      stdio: 'inherit',
      cwd: nodeLayerPath
    });
    return true;
  }

  async installLayers(sls) {
    const {installLayers} = this.config;

    if (!installLayers) {
      verbose(this, `Skipping installation of layers as per config`);
      return;
    }

    const layers = getLayers(sls);
    const installedLayers = Object.entries(layers)
      .filter(([layerName, layer]) => this.installLayer(sls, layer, layerName));

    info(this, `Installed ${installedLayers.length} layers`);

    await Promise.all(installedLayers.map(layer => this.delete(sls, layer.path)));
    return {installedLayers};
  }

  async delete(sls, folder) {
    const { clean } = this.config;
    if (!clean) return;
    const nodeLayerPath = `${folder}/nodejs`;
    console.log(`Cleaning ${(sls.service.package.exclude || []).map(rule => path.join(nodeLayerPath, rule)).join(', ')}`)
    await del(
      (sls.service.package.exclude || []).map(rule => path.join(nodeLayerPath, rule))
    );
  }

  transformLayerResources(sls) {
    const {exportLayers, exportPrefix, upgradeLayerReferences} = this.config;
    const layers = getLayers(sls);
    const {compiledCloudFormationTemplate: cf} = sls.service.provider;

    return Object.keys(layers).reduce((result, id) => {
      const name = pascalcase(id);
      const exportName = `${name}LambdaLayerQualifiedArn`;
      const output = cf.Outputs[exportName];

      if (!output) {
        return;
      }

      if (exportLayers) {
        output.Export = {
          Name: {
            'Fn::Sub': exportPrefix + exportName
          }
        };
        result.exportedLayers.push(output);
      }

      if (upgradeLayerReferences) {
        const resourceRef = `${name}LambdaLayer`;
        const versionedResourceRef = output.Value.Ref;

        if (resourceRef !== versionedResourceRef) {
          info(this, `Replacing references to ${resourceRef} with ${versionedResourceRef}`);

          Object.entries(cf.Resources)
            .forEach(([id, {Type: type, Properties: {Layers: layers = []} = {}}]) => {
              if (type === 'AWS::Lambda::Function') {
                layers.forEach(layer => {
                  if (layer.Ref === resourceRef) {
                    verbose(this, `${id}: Updating reference to layer version ${versionedResourceRef}`);
                    layer.Ref = versionedResourceRef;
                    result.upgradedLayerReferences.push(layer);
                  }
                })
              }
            });
        }
      }

      verbose(this, 'CF after transformation:\n', JSON.stringify(cf, null, 2));

      return result;
    }, {
      exportedLayers: [],
      upgradedLayerReferences: []
    });
  }
}

module.exports = LayerManagerPlugin;
