const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const config = getDefaultConfig(__dirname);

const ignoredAbsPaths = [
  path.resolve(__dirname, "..", "h2budget", "test-results"),
  path.resolve(__dirname, "..", "h2budget", "playwright-report"),
];

const ignoreRegexes = ignoredAbsPaths.map(
  (p) => new RegExp("^" + escapeRegex(p) + "(/|\\\\).*")
);

config.resolver = config.resolver || {};
const existingBlockList = config.resolver.blockList;
const existingArr = Array.isArray(existingBlockList)
  ? existingBlockList
  : existingBlockList
  ? [existingBlockList]
  : [];
config.resolver.blockList = [...existingArr, ...ignoreRegexes];

module.exports = config;
