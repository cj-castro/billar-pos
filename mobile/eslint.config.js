// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expo,
  { ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*'] },
  // axios/i18next default exports are the documented API; named duplicates are noise.
  { rules: { 'import/no-named-as-default-member': 'off' } },
]);
