import LayerManagerPlugin from '..';
import { PACKAGER_ADD_COMMAND } from '../constants';
import { Packager } from '../types';

import { exec } from '../utils';

const DEFAULT_CONFIG = {
  exportLayers: true,
  exportPrefix: '${AWS::StackName}-',
  installLayers: true,
  bulkInstall: false,
  upgradeLayerReferences: true,
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

function createSls(layerConfig = {}) {
  return {
    service: {
      provider: {
        compiledCloudFormationTemplate: {
          Resources: {
            FooLambdaLayer3ed25b0e140bd1e41c1e324ac4792fd38d3757af: {
              Type: 'AWS::Lambda::LayerVersion',
              Properties: {
                LayerName: 'Foo',
              },
              DeletionPolicy: 'Retain',
            },
            BarLambdaLayer9d80ae7472d5ab9ca001e6a13cdca0aba66c372f: {
              Type: 'AWS::Lambda::LayerVersion',
              Properties: {
                LayerName: 'Bar',
              },
              DeletionPolicy: 'Retain',
            },
            HelloLambdaFunction: {
              Type: 'AWS::Lambda::Function',
              Properties: {
                FunctionName: 'hello',
                Layers: [
                  {
                    Ref: 'FooLambdaLayer',
                  },
                ],
              },
            },
          },
          Outputs: {
            FooLambdaLayerQualifiedArn: {
              Value: {
                Ref: 'FooLambdaLayer3ed25b0e140bd1e41c1e324ac4792fd38d3757af',
              },
            },
            BarLambdaLayerQualifiedArn: {
              Value: {
                Ref: 'BarLambdaLayer9d80ae7472d5ab9ca001e6a13cdca0aba66c372f',
              },
            },
          },
        },
      },
      custom: {
        layerConfig,
      },
      functions: {
        hello: {
          handler: 'examples/example-layer-service/hello.default',
          layers: [
            {
              Ref: 'FooLambdaLayer',
            },
          ],
        },
      },
      layers: {
        foo: {
          path: 'Foo',
        },
        bar: {
          path: 'Bar',
        },
      },
    },
  };
}

jest.mock('../utils', () => ({
  ...jest.requireActual('../utils'),
  exec: jest.fn(),
}));

class Plugin extends LayerManagerPlugin {
  // Mock the install method
  async installLayer() {
    return true;
  }
}

function createMockPlugin(sls, options = {}) {
  const plugin = new Plugin(sls, options);
  plugin.init(sls);

  return plugin;
}

function createPlugin(sls, options = {}) {
  const plugin = new LayerManagerPlugin(sls, options);
  plugin.init(sls);

  return plugin;
}

describe(`Plugin tests`, () => {
  it(`should create plugin with default config successfully`, async () => {
    const plugin = createMockPlugin(createSls());

    expect(plugin.config).toEqual(DEFAULT_CONFIG);
  });

  it(`should create plugin with custom config successfully`, async () => {
    const config = {
      exportLayers: false,
      exportPrefix: 'PREFIX',
      installLayers: false,
      bulkInstall: false,
    };

    const plugin = createMockPlugin(createSls(config));

    expect(plugin.config).toEqual({
      ...DEFAULT_CONFIG,
      ...config,
    });
  });

  it('should set log level using -v or --verbose flag', () => {
    expect(createMockPlugin(createSls()).level).not.toBe('verbose');
    expect(createMockPlugin(createSls(), { v: true }).level).toBe('verbose');
    expect(createMockPlugin(createSls(), { verbose: true }).level).toBe('verbose');
  });

  it(`should install layers successfully`, async () => {
    const sls = createSls({ manageNodeFolder: true });
    const plugin = createMockPlugin(sls);

    const { installedLayers } = await plugin.installLayers(sls as any);
    expect(installedLayers).toHaveLength(2);
  });

  it(`should export layers successfully`, async () => {
    const sls = createSls({
      exportLayers: true,
      upgradeLayerReferences: false,
    });
    const plugin = createMockPlugin(sls);

    const { exportedLayers, upgradedLayerReferences } = await plugin.transformLayerResources(sls as any);
    expect(exportedLayers).toHaveLength(2);
    expect(upgradedLayerReferences).toHaveLength(0);
  });

  it(`should upgrade versioned layer references successfully`, async () => {
    const sls = createSls({
      exportLayers: false,
      upgradeLayerReferences: true,
    });
    const plugin = createMockPlugin(sls);

    const { exportedLayers, upgradedLayerReferences } = await plugin.transformLayerResources(sls as any);
    expect(exportedLayers).toHaveLength(0);
    expect(upgradedLayerReferences).toHaveLength(1);
  });
});

describe('plugin install', () => {
  const packagers: Packager[] = ['npm', 'yarn', 'pnpm'];
  for (const packager of packagers) {
    it(`should install layers successfully - ${packager}`, async () => {
      const sls = createSls({
        manageNodeFolder: true,
        webpack: {
          ...DEFAULT_CONFIG.webpack,
          configPath: './src/__tests__/webpack.config.js',
        },
        packager,
      });
      const plugin = createPlugin(sls);
      const { installedLayers } = await plugin.installLayers(sls as any);
      expect(exec).toHaveBeenCalledWith(`NODE_ENV=production ${PACKAGER_ADD_COMMAND[packager]} lodash`, {
        cwd: 'Foo/nodejs',
        encoding: null,
      });
      expect(installedLayers).toHaveLength(2);
    });
  }
});
