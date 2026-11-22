/* global require, module */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withXcodeProject } = require('expo/config-plugins');

module.exports = (config) =>
  withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const targets = Object.values(project.pbxNativeTargetSection()).filter(
      (target) => target?.productType === '"com.apple.product-type.application"',
    );
    if (targets.length !== 1) throw new Error('Expected one qualification application target');
    const lists = project.pbxXCConfigurationList();
    const configurations = project.pbxXCBuildConfigurationSection();
    const release = lists[targets[0].buildConfigurationList]?.buildConfigurations
      .map(({ value }) => configurations[value])
      .filter(({ name }) => name === 'Release');
    if (release?.length !== 1) throw new Error('Expected one Release configuration');
    const settings = release[0].buildSettings;
    settings.LD_GENERATE_MAP_FILE = 'YES';
    settings.LD_MAP_FILE_PATH = '"$(TARGET_TEMP_DIR)/BunnyHttpsLinkMap-$(CURRENT_ARCH).txt"';
    // Retain the target's symbols and dSYM for qualification only.
    settings.COPY_PHASE_STRIP = 'NO';
    settings.STRIP_INSTALLED_PRODUCT = 'NO';
    settings.DEBUG_INFORMATION_FORMAT = '"dwarf-with-dsym"';
    return mod;
  });
