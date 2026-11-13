import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import puppeteer from "puppeteer";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(ROOT, "frames");
const OUTPUT_DIR = join(ROOT, "dist");
const OUTPUT_FILE = join(OUTPUT_DIR, "wakatime-flight.webp");
const WIDTH = 1040;
const HEIGHT = 520;
const FPS = 12;
const MAX_TOWERS = 8;
const IGNORED = new Set((process.env.IGNORED_LANGUAGES ?? "YAML JSON TOML").split(/\s+/).filter(Boolean));

async function fetchStats() {
  const key = process.env.WAKATIME_API_KEY;
  if (!key) throw new Error("WAKATIME_API_KEY is not set");
  const response = await fetch("https://wakatime.com/api/v1/users/current/stats/all_time", {
    headers: { Authorization: `Basic ${Buffer.from(key).toString("base64")}` },
  });
  if (!response.ok) throw new Error(`WakaTime API responded ${response.status} ${response.statusText}`);
  const { data } = await response.json();
  return {
    total: data.human_readable_total,
    languages: data.languages.map((lang) => ({ name: lang.name, seconds: lang.total_seconds, text: lang.text })),
  };
}

function pickTowers(stats) {
  const kept = stats.languages.filter((lang) => !IGNORED.has(lang.name));
  const other = kept.findIndex((lang) => lang.name === "Other");
  const languages = (other === -1 ? kept : kept.slice(0, other + 1)).slice(0, MAX_TOWERS);
  if (languages.length < 2) throw new Error(`Need at least 2 languages to draw, got ${languages.length}`);
  return { total: stats.total, languages };
}

async function captureFrames(waka) {
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => {
      throw error;
    });
    await page.evaluateOnNewDocument((data) => {
      window.WAKA = data;
    }, waka);
    await page.goto(pathToFileURL(join(ROOT, "scene.html")).href, { waitUntil: "networkidle0" });
    await page.evaluate(() => window.sceneReady);
    const seconds = await page.evaluate(() => window.SCENE_SECONDS);
    const frameCount = Math.round(seconds * FPS);
    for (let i = 0; i < frameCount; i++) {
      await page.evaluate((time) => window.renderFrame(time), i / FPS);
      await page.screenshot({ path: join(FRAMES_DIR, `${String(i).padStart(4, "0")}.png`) });
    }
    return frameCount;
  } finally {
    await browser.close();
  }
}

function encode() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  execFileSync(
    ffmpegPath,
    [
      "-y", "-loglevel", "error",
      "-framerate", String(FPS),
      "-i", join(FRAMES_DIR, "%04d.png"),
      "-c:v", "libwebp_anim",
      "-loop", "0",
      "-q:v", "75",
      "-compression_level", "4",
      OUTPUT_FILE,
    ],
    { stdio: "inherit" },
  );
}

const sampleFile = process.argv[2];
const stats = sampleFile ? JSON.parse(readFileSync(sampleFile, "utf8")) : await fetchStats();
const frameCount = await captureFrames(pickTowers(stats));
encode();
console.log(`${frameCount} frames -> ${OUTPUT_FILE} (${(statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(2)} MB)`);
