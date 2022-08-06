const { merge } = require('webpack-merge');
const slsw = require('serverless-webpack');
const nodeExternals = require('webpack-node-externals');

const base = require('./config.base.js');

module.exports = merge(base, {
  entry: slsw.lib.entries,
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