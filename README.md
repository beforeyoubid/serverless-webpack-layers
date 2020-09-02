# serverless-webpack-layers
<!-- 
[![NPM version](https://img.shields.io/npm/v/serverless-plugin-layer-manager.svg)](https://www.npmjs.com/package/serverless-plugin-layer-manager)
[![Build Status](https://travis-ci.com/henhal/serverless-plugin-layer-manager.svg?branch=master)](https://travis-ci.com/henhal/serverless-plugin-layer-manager) -->

Plugin for the Serverless framework that offers AWS Lambda layer management alongside Webpack configuration.

Similar to [serverless-webpack](https://github.com/serverless-heaven/serverless-webpack) which can bundle modules by identifying what is used within your functions, this plugin can identify what modules are used by your functions and spread the node modules out to AWS Lambda Layers to reduce and improve start time and to share dependencies across functions.

This module works alongside `serverless-webpack` but can work by itself as long as you make sure you are not bundling your `node_modules` into your functions.

# Installation:

```shell
npm install --save-dev serverless-webpack-layers
yarn add --dev serverless-webpack-layers

sls plugin install -n serverless-webpack-layers
```

## `webpack` config:

Make sure to add the [`webpack-node-externals`](https://www.npmjs.com/package/webpack-node-externals) plugin to your webpack config to avoid bundling modules:
```js
const nodeExternals = require('webpack-node-externals');

module.exports = {
  // config here
  externals: [nodeExternals()],
};
```

## `serverless.yml`:

```yml
plugins:
  - serverless-webpack-layers
```

Once you've installed the plugin, add layer(s) for each function:

```yml
layers:
  lib:
    path: lib
    name: node-modules
    description: My node modules
    retain: true
    
functions:
  hello:
    handler: index.handler
    layers:
      # Note the reference being the TitleCase representation of the layer id followed by "LambdaLayer"
      - {Ref: LibLambdaLayer}
```

The `lib` layer will be installed and its `node_modules` packaged into the artifact, and the function will use the layer.

You also will want to add a `layerConfig` property with the following properties:

```yml
custom:
  layerConfig:
    packager: [yarn, npm] # defaults to npm
    manageNodeFolder: <boolean> # defaults to false, this lets the plugin control the existence of the layer's nodejs folder
    webpack:
      clean: true # this will clean and remove files/folders according to package.exclude
      backupFileType: <string> # defaults to js, is used when plugin cannot determine which file is the function handler
      configPath: <string> # defaults to ./webpack.config.js, is used to denote the path of your webpack config
      forceInclude: [<string>] # defaults to [], list of modules to force include
      forceExclude: [<string>] # defaults to [], list of modules to force exclude

    installLayers: <boolean>
    exportLayers: <boolean>
    upgradeLayerReferences: <boolean>
    exportPrefix: <prefix used for the names of the exported layers> # defaults to '${AWS:StackName}-'.
```

Note:

- You will want to make sure your `webpack.entry` field is empty, not controlled by `serverless-webpack`
