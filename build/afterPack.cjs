const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const path = require('node:path');

/**
 * Flip Electron's security fuses on the packaged binary.
 *
 * The one that matters most is `RunAsNode`. With it enabled — which is the
 * default — anyone who can set an environment variable can do this:
 *
 *     ELECTRON_RUN_AS_NODE=1 Aperture.exe -e "require('fs').readFileSync(vault)"
 *
 * That turns our own signed, user-trusted binary into a general-purpose Node
 * interpreter. It is a living-off-the-land escalation: it sails past
 * application allowlisting precisely because the binary is legitimately
 * installed and signed, and it runs with the user's full filesystem access —
 * which includes the vault file and the DPAPI-protected profile store.
 *
 * Verified present before this change: `ELECTRON_RUN_AS_NODE=1 npx electron -e
 * "console.log(process.version)"` printed a Node version.
 */
exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  const ext = {
    darwin: '.app',
    win32: '.exe',
    linux: '',
  }[electronPlatformName];

  const executableName = packager.appInfo.productFilename;
  const electronBinaryPath = path.join(appOutDir, `${executableName}${ext}`);

  await flipFuses(electronBinaryPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',

    // The escalation above.
    [FuseV1Options.RunAsNode]: false,

    // --inspect on a browser holding a password vault would expose the
    // process's memory to anything that can reach the debug port.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,

    // Cookies and localStorage get OS-level encryption at rest.
    [FuseV1Options.EnableCookieEncryption]: true,

    // NODE_OPTIONS is another route to injecting code at startup.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,

    // Refuse to run if the asar has been tampered with, and refuse to load
    // app code from anywhere but the asar. Together these stop an attacker
    // swapping in modified JS without re-signing.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  console.log(`[aperture] security fuses flipped on ${electronBinaryPath}`);
};
