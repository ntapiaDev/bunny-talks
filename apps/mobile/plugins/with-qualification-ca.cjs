/* global require, module, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS. */
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

module.exports = (config) =>
  withDangerousMod(config, [
    'android',
    async (mod) => {
      const root = path.join(mod.modRequest.platformProjectRoot, 'app/src/debug');
      const certificate = process.env.BUNNY_QUALIFICATION_CA;
      if (!certificate) return mod;
      const pem = fs.readFileSync(certificate, 'utf8');
      if (!pem.startsWith('-----BEGIN CERTIFICATE-----') || pem.includes('PRIVATE KEY'))
        throw new Error('Public CA certificate required');
      fs.mkdirSync(path.join(root, 'res/raw'), { recursive: true });
      fs.mkdirSync(path.join(root, 'res/xml'), { recursive: true });
      fs.writeFileSync(path.join(root, 'res/raw/bunny_qualification_ca.pem'), pem);
      fs.writeFileSync(
        path.join(root, 'res/xml/bunny_qualification_network.xml'),
        `<network-security-config>
          <base-config cleartextTrafficPermitted="true" />
          <debug-overrides>
            <trust-anchors>
              <certificates src="@raw/bunny_qualification_ca" />
            </trust-anchors>
          </debug-overrides>
        </network-security-config>`,
      );
      const manifest = path.join(root, 'AndroidManifest.xml');
      let xml = fs.readFileSync(manifest, 'utf8');
      if (
        xml.includes('android:networkSecurityConfig=') &&
        !xml.includes('@xml/bunny_qualification_network')
      )
        throw new Error('Existing security config requires review');
      if (!xml.includes('@xml/bunny_qualification_network'))
        xml = xml.replace(
          '<application ',
          '<application android:networkSecurityConfig="@xml/bunny_qualification_network" ',
        );
      fs.writeFileSync(manifest, xml);
      return mod;
    },
  ]);
