import LayerManagerPlugin from '..';

const DEFAULT_CONFIG = {
  exportLayers: true,
  exportPrefix: '${AWS::StackName}-',
  installLayers: true,
  upgradeLayerReferences: true,
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

class Plugin extends LayerManagerPlugin {
  // Mock the install method
  async installLayer() {
    return true;
  }
}

function createPlugin(sls, options = {}) {
  const plugin = new Plugin(sls, options);
  plugin.init(sls);

  return plugin;
}

describe(`Plugin tests`, () => {
  it(`should create plugin with default config successfully`, async () => {
    const plugin = createPlugin(createSls());

    expect(plugin.config).toEqual(DEFAULT_CONFIG);
  });

  it(`should create plugin with custom config successfully`, async () => {
    const config = {
      exportLayers: false,
      exportPrefix: 'PREFIX',
      installLayers: false,
    };

    const plugin = createPlugin(createSls(config));

    expect(plugin.config).toEqual({
      ...DEFAULT_CONFIG,
      ...config,
    });
  });

  it('should set log level using -v or --verbose flag', () => {
    expect(createPlugin(createSls()).level).not.toBe('verbose');
    expect(createPlugin(createSls(), { v: true }).level).toBe('verbose');
    expect(createPlugin(createSls(), { verbose: true }).level).toBe('verbose');
  });

  it(`should install layers successfully`, async () => {
    const sls = createSls({ manageNodeFolder: true });
    const plugin = createPlugin(sls);

    const { installedLayers } = await plugin.installLayers(sls as any);
    expect(installedLayers).toHaveLength(2);
  });

  it(`should export layers successfully`, async () => {
    const sls = createSls({
      exportLayers: true,
      upgradeLayerReferences: false,
    });
    const plugin = createPlugin(sls);

    const { exportedLayers, upgradedLayerReferences } = await plugin.transformLayerResources(sls as any);
    expect(exportedLayers).toHaveLength(2);
    expect(upgradedLayerReferences).toHaveLength(0);
  });

  it(`should upgrade versioned layer references successfully`, async () => {
    const sls = createSls({
      exportLayers: false,
      upgradeLayerReferences: true,
    });
    const plugin = createPlugin(sls);

    const { exportedLayers, upgradedLayerReferences } = await plugin.transformLayerResources(sls as any);
    expect(exportedLayers).toHaveLength(0);
    expect(upgradedLayerReferences).toHaveLength(1);
  });
});
