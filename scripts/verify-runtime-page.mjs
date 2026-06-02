import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const port = Number(process.env.RUNTIME_VERIFY_PORT ?? 5174);
const baseUrl = `http://127.0.0.1:${port}/btc-dca-monitor/?runtimeFixture=1`;
const screenshotPath = process.env.RUNTIME_VERIFY_SCREENSHOT ?? join(tmpdir(), 'btc-dca-monitor-runtime.png');
const chromeProfileDir = join(tmpdir(), `btc-dca-monitor-chrome-${Date.now()}`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function findChrome() {
  if (process.env.CHROME_BIN) {
    await access(process.env.CHROME_BIN);
    return process.env.CHROME_BIN;
  }

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }

  throw new Error('Chrome not found. Set CHROME_BIN to a headless-capable Chrome/Chromium executable.');
}

async function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function withDevServer(fn) {
  const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl);
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\nDev server output:\n${serverOutput}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 1500);
    });
  }
}

function chromeArgs(extraArgs) {
  return [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    `--user-data-dir=${chromeProfileDir}`,
    '--window-size=1440,1800',
    '--virtual-time-budget=15000',
    ...extraArgs,
    baseUrl,
  ];
}

async function verifyScreenshot(chrome) {
  await captureScreenshot(chrome);
  const screenshot = await stat(screenshotPath);
  assert(screenshot.size > 220_000, `runtime screenshot looks too small for a loaded chart: ${screenshot.size} bytes`);
  await verifyScreenshotPixels(screenshotPath);
}

async function captureScreenshot(chrome) {
  await rm(screenshotPath, { force: true });
  const browser = spawn(chrome, chromeArgs([`--screenshot=${screenshotPath}`]), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  browser.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const startedAt = Date.now();
  let exited = false;
  browser.once('exit', () => {
    exited = true;
  });

  while (Date.now() - startedAt < 60_000) {
    try {
      const screenshot = await stat(screenshotPath);
      if (screenshot.size > 220_000) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        browser.kill('SIGTERM');
        return;
      }
    } catch {
      // Screenshot has not been created yet.
    }

    if (exited) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!exited) {
    browser.kill('SIGTERM');
  }

  throw new Error(`Chrome did not produce a loaded screenshot in time.\n${stderr}`);
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);

  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  if (aboveDistance <= upperLeftDistance) {
    return above;
  }
  return upperLeft;
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

async function decodePngPixels(filePath) {
  const png = await readFile(filePath);
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'screenshot is not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const dataChunks = [];

  while (offset < png.length) {
    const length = readUInt32(png, offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      colorType = data[9];
      assert(data[8] === 8, 'only 8-bit PNG screenshots are supported');
      assert(colorType === 2 || colorType === 6, `unsupported PNG color type ${colorType}`);
    } else if (type === 'IDAT') {
      dataChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(dataChunks));
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const rowStart = row * stride;

    for (let column = 0; column < stride; column += 1) {
      const raw = inflated[inputOffset + column];
      const left = column >= bytesPerPixel ? pixels[rowStart + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[rowStart + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel ? pixels[rowStart + column - stride - bytesPerPixel] : 0;

      if (filter === 0) {
        pixels[rowStart + column] = raw;
      } else if (filter === 1) {
        pixels[rowStart + column] = (raw + left) & 0xff;
      } else if (filter === 2) {
        pixels[rowStart + column] = (raw + above) & 0xff;
      } else if (filter === 3) {
        pixels[rowStart + column] = (raw + Math.floor((left + above) / 2)) & 0xff;
      } else if (filter === 4) {
        pixels[rowStart + column] = (raw + paeth(left, above, upperLeft)) & 0xff;
      } else {
        throw new Error(`unsupported PNG filter ${filter}`);
      }
    }
    inputOffset += stride;
  }

  return { width, height, bytesPerPixel, pixels };
}

async function verifyScreenshotPixels(filePath) {
  const { width, height, bytesPerPixel, pixels } = await decodePngPixels(filePath);
  assert(width >= 1200 && height >= 1200, `runtime screenshot dimensions are too small: ${width}x${height}`);

  let yellowMarkerPixels = 0;
  let greenCandlePixels = 0;
  let redCandlePixels = 0;

  for (let offset = 0; offset < pixels.length; offset += bytesPerPixel) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];

    if (red > 180 && green > 150 && blue < 130) {
      yellowMarkerPixels += 1;
    }
    if (green > 130 && red < 90 && blue < 130) {
      greenCandlePixels += 1;
    }
    if (red > 170 && green < 100 && blue < 110) {
      redCandlePixels += 1;
    }
  }

  assert(yellowMarkerPixels > 20, `chart is missing yellow bottom-signal marker pixels: ${yellowMarkerPixels}`);
  assert(greenCandlePixels > 100, `chart is missing green candle pixels: ${greenCandlePixels}`);
  assert(redCandlePixels > 100, `chart is missing red candle pixels: ${redCandlePixels}`);
}

async function main() {
  const chrome = await findChrome();
  await mkdir(chromeProfileDir, { recursive: true });
  try {
    await withDevServer(async () => {
      await verifyScreenshot(chrome);
    });
  } finally {
    await cleanupChromeProfile();
  }

  console.log(`Runtime page verification passed. Screenshot: ${screenshotPath}`);
}

async function cleanupChromeProfile() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(chromeProfileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
