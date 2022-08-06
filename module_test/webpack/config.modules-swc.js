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
            loader: 'swc-loader',
            options: {
              jsc: {
                parser: {
                  syntax: 'typescript',
                },
              },
            },
          },
        ],
        exclude: /node_modules/,
      },
    ],
  },
});