const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const appDirectory = path.resolve(__dirname);

const babelConfig = {
  loader: 'babel-loader',
  options: {
    configFile: path.resolve(appDirectory, 'babel.web.config.js'),
    cacheDirectory: true,
  },
};

module.exports = {
  mode: 'development',
  entry: './index.web.js',
  output: {
    path: path.resolve(appDirectory, 'dist'),
    filename: 'bundle.js',
    publicPath: '/',
  },
  resolve: {
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js'],
    alias: {
      'react-native$': 'react-native-web',
      'react-native/Libraries/Utilities/Platform': path.resolve(
        appDirectory,
        'node_modules/react-native-web/dist/exports/Platform'
      ),
    },
    fallback: {
      crypto: false,
      stream: false,
      buffer: false,
    },
  },
  module: {
    rules: [
      // ── Source files (project root, never node_modules) ──────────────────
      {
        test: /\.(js|mjs|jsx|ts|tsx)$/,
        exclude: /node_modules/,
        use: babelConfig,
        resolve: { fullySpecified: false },
      },
      // ── node_modules that need transpilation ─────────────────────────────
      {
        test: /\.(js|mjs|jsx|ts|tsx)$/,
        include: [
          path.resolve(appDirectory, 'node_modules/react-native-web'),
          path.resolve(appDirectory, 'node_modules/@react-native-async-storage'),
          path.resolve(appDirectory, 'node_modules/@react-native'),
          path.resolve(appDirectory, 'node_modules/react-native-vector-icons'),
          path.resolve(appDirectory, 'node_modules/react-native-linear-gradient'),
          path.resolve(appDirectory, 'node_modules/react-native-haptic-feedback'),
          path.resolve(appDirectory, 'node_modules/@react-native-community'),
        ],
        use: babelConfig,
        resolve: { fullySpecified: false },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.(png|jpe?g|gif|svg|ico)$/i,
        type: 'asset/resource',
      },
      {
        test: /\.(ttf|otf|woff|woff2|eot)$/,
        type: 'asset/resource',
      },
      {
        test: /\.json$/,
        type: 'json',
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './web/index.html',
      filename: 'index.html',
    }),
  ],
  devServer: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: 'all',
    hot: true,
    historyApiFallback: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    client: {
      webSocketURL: 'auto://0.0.0.0:0/ws',
      overlay: {
        errors: true,
        warnings: false,
      },
    },
  },
};
