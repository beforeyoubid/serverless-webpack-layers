const nodeExternals = require('webpack-node-externals');

module.exports = {
  entry: {},
  mode: 'production',
  devtool: 'eval-cheap-module-source-map',
  target: 'node',
  node: {
    __dirname: true,
  },
  externals: [nodeExternals()],
  optimization: {
    minimize: false,
  },
  performance: {
    hints: 'warning',
  },
  resolve: {
    extensions: ['.ts', '.js', '.tsx', '.jsx'],
    symlinks: true,
  },
};
