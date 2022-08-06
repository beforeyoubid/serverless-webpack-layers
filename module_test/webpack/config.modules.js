const { merge } = require('webpack-merge');
const base = require('./config.base.js');
const nodeExternals = require('webpack-node-externals');

module.exports = merge(base, {
  entry: {},
  devtool: 'source-map',
  externals: [nodeExternals()],
  module: {
    rules: [
      {
        test: /\.ts(x?)$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
            },
          },
        ],
        exclude: /node_modules/,
      },
    ],
  },
});