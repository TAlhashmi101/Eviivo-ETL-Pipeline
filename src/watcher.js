const path = require('path');
const chokidar = require('chokidar');
const { importBookings, importPayments } = require('./importData');

const rawDataDir = path.join(__dirname, '..', 'raw_data');

console.log(`👀 Watching for new/updated CSV reports in: ${rawDataDir}`);

const watcher = chokidar.watch(rawDataDir, {
  ignored: /(^|[\/\\])\../, // ignore hidden files
  persistent: true,
  ignoreInitial: true,     // ignore existing files on startup
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 100
  }
});

watcher.on('add', async (filePath) => {
  await handleFile(filePath, 'Added');
});

watcher.on('change', async (filePath) => {
  await handleFile(filePath, 'Updated');
});

async function handleFile(filePath, eventType) {
  if (!filePath.endsWith('.csv')) return;

  const relativePath = path.relative(rawDataDir, filePath);
  const parts = relativePath.split(path.sep);

  // Expected folder structure: raw_data/<groupName>/<file.csv>
  if (parts.length < 2) return;

  const groupName = parts[0];
  const fileName = parts[parts.length - 1];

  console.log(`\n🔔 [${eventType}] Detected CSV: ${fileName} in group [${groupName}]`);

  try {
    if (fileName.toLowerCase().includes('payment')) {
      await importPayments(filePath, groupName);
    } else {
      await importBookings(filePath, groupName);
    }
    console.log(`✨ Ingestion completed automatically for ${fileName}`);
  } catch (err) {
    console.error(`❌ Automatic processing failed for ${fileName}:`, err.message);
  }
}