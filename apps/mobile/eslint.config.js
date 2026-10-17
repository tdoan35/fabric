const { defineConfig } = require("eslint/config");

const expoConfig = require("eslint-config-expo/flat");

// https://docs.expo.dev/guides/using-eslint/
module.exports = defineConfig([expoConfig, {
  ignores: ["dist/*"],
}]);
