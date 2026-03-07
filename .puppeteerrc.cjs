const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Indica a Puppeteer que descargue y busque Chrome en la carpeta del proyecto
  // Esto es necesario para que Render persista el navegador entre deploys
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
