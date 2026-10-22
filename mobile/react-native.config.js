/**
 * Autolinking is switched off for the Material Design Icons font package.
 *
 * The icon font is bundled as a plain asset
 * (`android/app/src/main/assets/fonts/MaterialDesignIcons.ttf`) and rendered
 * with `fontFamily: 'MaterialDesignIcons'`, which is exactly how React Native
 * resolves fonts on Android. The package's native module only implements
 * Expo-style *dynamic* font loading, which this app never uses.
 *
 * Autolinking it in registers a codegen target whose generated object paths
 * exceed CMake's 250-character limit on Windows, breaking the build with
 * `ninja: error: mkdir(...)`. Excluding it removes that target entirely.
 */
module.exports = {
  dependencies: {
    '@react-native-vector-icons/material-design-icons': {
      platforms: {
        android: null,
        ios: null,
      },
    },
  },
};