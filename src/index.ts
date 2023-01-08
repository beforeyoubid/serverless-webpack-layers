import pascalcase from 'pascalcase';
import fs from 'fs';
import path from 'path';
import del from 'del';
import { getExternalModules } from './external';
import { Packager, Maybe, Layer, FunctionLayerReference, TransformedLayerResources } from './types';
import { notEmpty, exec } from './utils';
import { PACKAGER_ADD_COMMAND, PACKAGER_INSTALL_COMMAND, PACKAGER_LOCK_FILE_NAMES } from './constants';
import Serverless from 'serverless';
import { CloudFormationResource, Output } from 'serverless/aws';
import minifyAll from 'minify-all-js';

const { LOG_LEVEL = 'info' } = process.env;

const DEFAULT_CONFIG = {
  installLayers: true,
  exportLayers: true,
  bulkInstall: false,
  upgradeLayerReferences: true,
  exportPrefix: '${AWS::StackName}-',
  manageNodeFolder: false,
  packager: 'npm',
  resolutions: {},
  webpack: {
    clean: true,
    minify: false,
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

function verbose({ level }: { level: keyof typeof LEVELS }, ...s: unknown[]) {
  LEVELS[level] >= LEVELS.verbose && log(...s);
}

function info({ level }: { level: keyof typeof LEVELS }, ...s: unknown[]) {
  LEVELS[level] >= LEVELS.info && log(...s);
}

function debug({ level }: { level: keyof typeof LEVELS }, ...s: unknown[]) {
  LEVELS[level] >= LEVELS.debug && log(...s);
}

function getLayers(serverless: Serverless): { [key: string]: Layer } {
  return serverless.service.layers || {};
}

function getConfig(serverless: Serverless) {
  const custom = serverless.service.custom || {};

  return {
    ...DEFAULT_CONFIG,
    ...custom.layerConfig,
    webpack: {
      ...DEFAULT_CONFIG.webpack,
      ...(custom.layerConfig.webpack ?? {}),
    },
  };
}

export default class LayerManagerPlugin {
  level: keyof typeof LEVELS;
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
    packager?: Packager;
    resolutions?: Record<string, string>;
    webpack: Partial<{
      clean: boolean;
      minify: boolean;
      backupFileType: 'js' | 'ts' | 'cjs';
      configPath: string;
      discoverModules: boolean;
    }>;
    productionMode?: boolean;
  } = { webpack: {} };
  constructor(sls: Serverless, options: Record<string, unknown> = {}) {
    this.level = (options.v || options.verbose ? 'verbose' : LOG_LEVEL) as keyof typeof LEVELS;

    debug(this, `Invoking webpack-layers plugin`);
    this.init(sls);

    this.hooks = {
      'package:initialize': () => this.installLayers(sls),
      'before:deploy:deploy': () => this.transformLayerResources(sls),
    };
  }

  init(sls: Serverless): void {
    this.config = getConfig(sls);
  }

  async installLayer(sls: Serverless, layer: Layer, layerName: string): Promise<boolean> {
    const { path: localPath } = layer;
    const layerRefName = `${layerName.replace(/^./, x => x.toUpperCase())}LambdaLayer`;
    const nodeLayerPath = `${localPath}/nodejs`;
    const packageJsonPath = path.join(nodeLayerPath, 'package.json');
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
      await fs.promises.copyFile(path.join(process.cwd(), 'package.json'), packageJsonPath);
      const fileName = PACKAGER_LOCK_FILE_NAMES[this.config.packager ?? 'npm'];
      try {
        await fs.promises.copyFile(path.join(process.cwd(), fileName), path.join(nodeLayerPath, fileName));
      } catch {
        info(this, `Unable to copy ${fileName} across, this will cause version inaccuracies`);
      }
    } else if (this.config.manageNodeFolder) {
      await fs.promises.writeFile(packageJsonPath, '{}');
    }
    verbose(this, `Installing nodejs layer ${localPath} with ${this.config.packager}`);

    const productionModeFlagEnvironmentAgnostic =
      process.platform === 'win32' ? 'set NODE_ENV=production &&' : 'NODE_ENV=production';
    const productionModeFlag = this.config.productionMode ? productionModeFlagEnvironmentAgnostic : '';
    let command = productionModeFlag + PACKAGER_INSTALL_COMMAND[this.config.packager ?? 'npm'];
    let installingPackages = false;
    if (this.config.webpack) {
      const packages = await getExternalModules(sls, layerRefName);
      if (packages.length !== 0) {
        command = `${productionModeFlag} ${PACKAGER_ADD_COMMAND[this.config.packager ?? 'npm']} ${packages
          .join(' ')
          .trim()}`;
        installingPackages = true;
      } else {
        command = 'ls';
      }
    }
    info(this, `Running command ${command}`);
    if (this.config.packager === 'yarn' && Object.keys(this.config.resolutions ?? {}).length > 0) {
      try {
        const jsonString = await fs.promises.readFile(packageJsonPath, {
          encoding: 'utf-8',
        });
        const json = JSON.parse(jsonString);
        json['resolutions'] = this.config.resolutions;
        await fs.promises.writeFile(packageJsonPath, JSON.stringify(json));
      } catch (e) {
        console.error(`Unable to add resolutions`, e);
      }
    }
    await exec(command, {
      cwd: nodeLayerPath,
      encoding: null,
    });
    if (this.config.packager === 'yarn' && installingPackages) {
      await exec(`yarn autoclean --init`, { cwd: nodeLayerPath, encoding: null });
    }
    return true;
  }

  async installLayers(sls: Serverless): Promise<{ installedLayers: Layer[] }> {
    verbose(this, `Config: `, this.config);
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
    const { clean, minify } = this.config.webpack;
    if (!clean) return;
    const nodeLayerPath = `${folder}/nodejs`;
    const exclude: string[] =
      sls.service?.package?.exclude ??
      sls.service?.package?.patterns
        ?.filter((p: string) => p.startsWith('!'))
        .map((p: string) => p.replace(/^!/, '')) ??
      [];
    info(this, `Cleaning ${exclude.map(rule => path.join(nodeLayerPath, rule)).join(', ')}`);
    const filesDeleted = await del(exclude.map(rule => path.join(nodeLayerPath, rule)));
    if (fs.existsSync(nodeLayerPath) && minify) {
      await minifyAll(nodeLayerPath, {
        compress_json: true,
        module: true,
        mangle: true,
        packagejson: true,
      });
    }
    info(this, `Cleaned ${filesDeleted.length} files at ${nodeLayerPath}`);
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
