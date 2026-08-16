const path = require('path');
const fs = require('fs-extra');

console.log('Starting automated build...');

const currentDir = __dirname;

// Get the parent folder's path
const parentDir = path.join(currentDir, '..');
// Get the parent folder's name
const PluginName = path.basename(parentDir);


const PluginPath = path.join(process.env.APPDATA, 'HotSpot/StreamDock/plugins', PluginName);

try {
    // Remove the old plugin directory
    fs.removeSync(PluginPath);

    // Make sure the target directory exists
    fs.ensureDirSync(path.dirname(PluginPath));

    // Copy the current directory to the target path, excluding node_modules
    fs.copySync(path.resolve(__dirname, '..'), PluginPath, {
        filter: (src) => {
            const relativePath = path.relative(path.resolve(__dirname, '..'), src);
            // Exclude the 'node_modules' and '.git' directories and their contents
            return !relativePath.startsWith('plugin\\node_modules')
                 &&!relativePath.startsWith('plugin\\index.js')
                 &&!relativePath.startsWith('plugin\\package.json')
                 &&!relativePath.startsWith('plugin\\package-lock.json')
                 &&!relativePath.startsWith('plugin\\yarn.lock')
                 &&!relativePath.startsWith('plugin\\build')
                 &&!relativePath.startsWith('plugin\\log')
                 &&!relativePath.startsWith('.git')
                 &&!relativePath.startsWith('.vscode');
        }
    });

    fs.copySync( path.join(__dirname, "build"), path.join(PluginPath,'plugin'))

    console.log(`Plugin "${PluginName}" was successfully copied to "${PluginPath}"`);
    console.log('Build succeeded-------------');
} catch (err) {
    console.error(`Copy error for "${PluginName}":`, err);
}