import { execSync } from 'child_process';
import pascalcase from 'pascalcase';
import fs from 'fs';
import path from 'path';
import del from 'del';
import { getExternalModules } from './external';
import { Maybe, Layer, FunctionLayerReference, TransformedLayerResources } from './types';
import Serverless from 'serverless';
import { CloudFormationResource, Output } from 'serverless/aws';

const { LOG_LEVEL = 'info' } = process.env;

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
    configPath: './webpack.config.js',
    discoverModules: true,
  },
  productionMode: true,
};

const LEVELS = {
  none: 0,
  info: 1,
  verbose: 2,
  debug: 3,
};

function log(...s: unknown[]) {
  console.log('[webpack-layers]', ...s);
}

function verbose({ level }, ...s: unknown[]) {
  LEVELS[level] >= LEVELS.verbose && log(...s);
}

function info({ level }, ...s: unknown[]) {
  LEVELS[level] >= LEVELS.info && log(...s);
}

function debug({ level }, ...s: unknown[]) {
  LEVELS[level] >= LEVELS.debug && log(...s);
}

function getLayers(serverless: Serverless): { [key: string]: Layer } {
  return serverless.service.layers || {};
}

function getConfig(serverless: Serverless) {
  const custom = serverless.service.custom || {};

  return { ...DEFAULT_CONFIG, ...custom.layerConfig };
}

export default class LayerManagerPlugin {
  level: string;
  hooks: {
    [key: string]: () => Promise<unknown>;
  };
  config: {
    installLayers?: boolean;
    exportLayers?: boolean;
    upgradeLayerReferences?: boolean;
    exportPrefix?: string;
    manageNodeFolder?: boolean;
    packager?: 'npm' | 'yarn';
    webpack: Partial<{
      clean: boolean;
      backupFileType: 'js' | 'ts' | 'cjs';
      configPath: string;
      discoverModules: boolean;
    }>;
    productionMode?: boolean;
  } = { webpack: {} };
  constructor(sls: Serverless, options: Record<string, unknown> = {}) {
    this.level = options.v || options.verbose ? 'verbose' : LOG_LEVEL;

    debug(this, `Invoking webpack-layers plugin`);
    this.init(sls);

    this.hooks = {
      'package:initialize': () => this.installLayers(sls),
      'before:deploy:deploy': () => this.transformLayerResources(sls),
    };
  }

  init(sls: Serverless): void {
    this.config = getConfig(sls);
    verbose(this, `Config: `, this.config);
  }

  async installLayer(sls: Serverless, layer: Layer, layerName: string): Promise<boolean> {
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
      fs.mkdirSync(nodeLayerPath, { recursive: true });
    }
    if (!this.config.webpack) {
      fs.copyFileSync(path.join(process.cwd(), 'package.json'), path.join(nodeLayerPath, 'package.json'));
      if (this.config.packager === 'npm') {
        fs.copyFileSync(path.join(process.cwd(), 'package-lock.json'), path.join(nodeLayerPath, 'package-lock.json'));
      } else if (this.config.packager === 'yarn') {
        fs.copyFileSync(path.join(process.cwd(), 'yarn.lock'), path.join(nodeLayerPath, 'yarn.lock'));
      }
    } else if (this.config.manageNodeFolder) {
      fs.writeFileSync(path.join(nodeLayerPath, 'package.json'), '{}');
    }
    verbose(this, `Installing nodejs layer ${localPath} with ${this.config.packager}`);
    const productionModeFlag = this.config.productionMode ? 'NODE_ENV=production ' : '';
    let command = productionModeFlag + this.config.packager === 'npm' ? 'npm install' : 'yarn install';
    if (this.config.webpack) {
      const packages = await getExternalModules(sls, layerRefName);
      if (packages.length !== 0) {
        command =
          this.config.packager === 'npm'
            ? `${productionModeFlag} npm install ${packages.join(' ')}`
            : `${productionModeFlag} yarn add ${packages.join(' ')}`;
      } else {
        command = 'ls';
      }
    }
    info(this, `Running command ${command}`);
    execSync(command, {
      stdio: 'inherit',
      cwd: nodeLayerPath,
    });
    return true;
  }

  async installLayers(sls: Serverless): Promise<{ installedLayers: Layer[] }> {
    const { installLayers } = this.config;

    if (!installLayers) {
      verbose(this, `Skipping installation of layers as per config`);
      return { installedLayers: [] };
    }

    const layers = getLayers(sls);
    const installedLayers = Object.entries(layers)
      .filter(([layerName, layer]) => this.installLayer(sls, layer, layerName))
      .map(([, layer]) => layer);

    await Promise.all(
      installedLayers.filter(layer => typeof layer === 'object').map(layer => this.delete(sls, layer.path))
    );
    info(this, `Installed ${installedLayers.length} layers`);
    return { installedLayers };
  }

  async delete(sls: Serverless, folder: string): Promise<void> {
    const { clean } = this.config.webpack;
    if (!clean) return;
    const nodeLayerPath = `${folder}/nodejs`;
    const exclude: string[] = sls.service?.package?.exclude || [];
    console.log(`Cleaning ${exclude.map(rule => path.join(nodeLayerPath, rule)).join(', ')}`);
    await del(exclude.map(rule => path.join(nodeLayerPath, rule)));
  }

  async transformLayerResources(sls: Serverless): Promise<TransformedLayerResources> {
    if (!this.config) {
      log(this, 'Unable to add layers currently as config unavailable');
      return {
        exportedLayers: [],
        upgradedLayerReferences: [],
      };
    }
    const { exportLayers, exportPrefix, upgradeLayerReferences } = this.config;
    const layers = getLayers(sls);
    const { compiledCloudFormationTemplate: cf } = sls.service.provider;

    const layersKeys = Object.keys(layers);

    const transformedResources = layersKeys.reduce(
      (result: Maybe<TransformedLayerResources>, id: string) => {
        if (!result) {
          result = {
            exportedLayers: [],
            upgradedLayerReferences: [],
          };
        }
        const name = pascalcase(id);
        const exportName = `${name}LambdaLayerQualifiedArn`;
        const output: Maybe<Output> = (cf.Outputs ?? {})[exportName];

        if (!output) {
          return;
        }

        if (exportLayers) {
          output.Export = {
            Name: {
              'Fn::Sub': exportPrefix + exportName,
            },
          };
          result.exportedLayers.push(output);
        }

        if (upgradeLayerReferences) {
          const resourceRef = `${name}LambdaLayer`;
          const versionedResourceRef = output.Value.Ref;

          if (resourceRef !== versionedResourceRef) {
            info(this, `Replacing references to ${resourceRef} with ${versionedResourceRef}`);
            const resources = cf.Resources as { [key: string]: CloudFormationResource };
            for (const resource of Object.entries(resources)) {
              const [id, { Type: type, Properties = {} }] = resource;
              const {
                Layers: layers = [],
              }: Partial<CloudFormationResource['Properties'] & { Layers: FunctionLayerReference[] }> = Properties;
              if (type === 'AWS::Lambda::Function') {
                for (const layer of layers) {
                  if (layer.Ref === resourceRef) {
                    verbose(this, `${id}: Updating reference to layer version ${versionedResourceRef}`);
                    layer.Ref = versionedResourceRef;
                    result.upgradedLayerReferences.push(layer);
                  }
                }
              }
            }
          }
        }

        verbose(this, 'CF after transformation:\n', JSON.stringify(cf, null, 2));

        return result;
      },
      {
        exportedLayers: [],
        upgradedLayerReferences: [],
      }
    );
    return (
      transformedResources ?? {
        exportedLayers: [],
        upgradedLayerReferences: [],
      }
    );
  }
}
