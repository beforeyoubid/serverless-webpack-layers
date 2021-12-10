import { exec as execNonPromise, ExecOptions, ExecException } from 'child_process';
import util from 'util';
import pascalcase from 'pascalcase';
import fs from 'fs';
import path from 'path';
import del from 'del';
import { getExternalModules } from './external';
import { Maybe, Layer, FunctionLayerReference, TransformedLayerResources, notEmpty } from './types';
import Serverless from 'serverless';
import { CloudFormationResource, Output } from 'serverless/aws';
import minifyAll from 'minify-all-js';

const exec = util.promisify(
  (
    command: string,
    options: {
      encoding: 'buffer' | null;
    } & ExecOptions,
    callback: (error: ExecException | null, stdout: Buffer, stderr: Buffer) => void
  ) => execNonPromise(command, options, callback)
);

const { LOG_LEVEL = 'info' } = process.env;

const DEFAULT_CONFIG = {
  installLayers: true,
  exportLayers: true,
  bulkInstall: false,
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
    bulkInstall?: boolean;
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
      await fs.promises.mkdir(nodeLayerPath, { recursive: true });
    }
    if (!this.config.webpack) {
      await fs.promises.copyFile(path.join(process.cwd(), 'package.json'), path.join(nodeLayerPath, 'package.json'));
      if (this.config.packager === 'npm') {
        await fs.promises.copyFile(
          path.join(process.cwd(), 'package-lock.json'),
          path.join(nodeLayerPath, 'package-lock.json')
        );
      } else if (this.config.packager === 'yarn') {
        await fs.promises.copyFile(path.join(process.cwd(), 'yarn.lock'), path.join(nodeLayerPath, 'yarn.lock'));
      }
    } else if (this.config.manageNodeFolder) {
      await fs.promises.writeFile(path.join(nodeLayerPath, 'package.json'), '{}');
    }
    verbose(this, `Installing nodejs layer ${localPath} with ${this.config.packager}`);
    const productionModeFlag = this.config.productionMode ? 'NODE_ENV=production' : '';
    let command = productionModeFlag + this.config.packager === 'npm' ? 'npm install' : 'yarn install';
    if (this.config.webpack) {
      const packages = await getExternalModules(sls, layerRefName);
      if (packages.length !== 0) {
        command =
          this.config.packager === 'npm'
            ? `${productionModeFlag} npm install ${packages.join(' ').trim()}`
            : `${productionModeFlag} yarn add ${packages.join(' ').trim()}`;
      } else {
        command = 'ls';
      }
    }
    info(this, `Running command ${command}`);
    await exec(command, {
      cwd: nodeLayerPath,
      encoding: null,
    });
    if (this.config.packager === 'yarn') {
      await exec(`yarn autoclean --init`, { cwd: nodeLayerPath, encoding: null });
    }
    return true;
  }

  async installLayers(sls: Serverless): Promise<{ installedLayers: Layer[] }> {
    const { installLayers, bulkInstall = false } = this.config;

    if (!installLayers) {
      verbose(this, `Skipping installation of layers as per config`);
      return { installedLayers: [] };
    }

    const layers = getLayers(sls);
    let installedLayers: Layer[] = [];
    if (bulkInstall) {
      const attemptedInstallLayers = await Promise.all(
        Object.entries(layers).map(async ([layerName, layer]) => {
          if (typeof layer !== 'object') return;
          const installed = await this.installLayer(sls, layer, layerName);
          if (!installed) return;
          await this.delete(sls, layer.path);
          return layer;
        })
      );
      installedLayers = attemptedInstallLayers.filter(notEmpty);
    } else {
      for (const [layerName, layer] of Object.entries(layers)) {
        if (typeof layer !== 'object') continue;
        const installed = await this.installLayer(sls, layer, layerName);
        if (!installed) continue;
        await this.delete(sls, layer.path);
        installedLayers.push(layer);
      }
    }

    info(this, `Installed ${installedLayers.length} layer${installedLayers.length > 1 ? 's' : ''}`);
    return { installedLayers };
  }

  async delete(sls: Serverless, folder: string): Promise<void> {
    const { clean } = this.config.webpack;
    if (!clean) return;
    const nodeLayerPath = `${folder}/nodejs`;
    const exclude: string[] =
      sls.service?.package?.exclude ??
      sls.service?.package?.patterns?.filter(p => p.startsWith('!'))?.map(p => p.replace(/^!/, '')) ??
      [];
    info(this, `Cleaning ${exclude.map(rule => path.join(nodeLayerPath, rule)).join(', ')}`);
    const filesDeleted = await del(exclude.map(rule => path.join(nodeLayerPath, rule)));
    await minifyAll(nodeLayerPath, {
      compress_json: true,
      module: true,
      mangle: true,
      packagejson: true,
    });
    await info(this, `Cleaned ${filesDeleted.length} files at ${nodeLayerPath}`);
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
          return result;
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
