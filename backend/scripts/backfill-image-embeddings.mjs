import { PrismaClient } from "@prisma/client";
import { env, pipeline, RawImage } from "@xenova/transformers";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";

const DEFAULT_CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const DEFAULT_CLIP_DIMENSIONS = 512;
const IMAGE_BYTES_MAX = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const REMOVED_ARTWORK_IDS = [
  "plum-blossom",
  "shrimp",
  "aic-16568",
  "aic-89503",
  "reward-midnight",
  "reward-garden",
  "reward-gold-room",
];
const LOCAL_IMAGE_BY_ARTWORK_ID = {
  "starry-night": "/artworks/starry-night.jpg",
  "water-lilies": "/artworks/water-lilies.jpg",
  "mona-lisa": "/artworks/mona-lisa.jpg",
  "girl-pearl": "/artworks/girl-pearl.jpg",
  "great-wave": "/artworks/great-wave.jpg",
  ssireum: "/artworks/ssireum.jpg",
  "early-spring": "/artworks/early-spring.jpg",
  "the-kiss": "/artworks/the-kiss.jpg",
  "composition-vii": "/artworks/composition-vii.jpg",
  "mont-sainte": "/artworks/mont-sainte.jpg",
  "birth-venus": "/artworks/birth-venus.jpg",
  "the-scream": "/artworks/the-scream.jpg",
  "las-meninas": "/artworks/las-meninas.jpg",
};

loadEnv(resolve(process.cwd(), ".env"));

const prisma = new PrismaClient();
const workspaceRoot = process.cwd().endsWith("backend") ? resolve(process.cwd(), "..") : process.cwd();
const model = process.env.CLIP_IMAGE_MODEL?.trim() || DEFAULT_CLIP_MODEL;
const dimensions = Number(process.env.CLIP_IMAGE_DIMENSIONS || DEFAULT_CLIP_DIMENSIONS);
env.cacheDir = process.env.CLIP_CACHE_DIR?.trim() || resolve(workspaceRoot, "backend", ".cache", "transformers");
env.allowLocalModels = true;
env.allowRemoteModels = true;

const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || 0);
const force = process.argv.includes("--force");
const extractor = await pipeline("image-feature-extraction", model);

let indexed = 0;
let skipped = 0;
let failed = 0;

try {
  const artworks = await loadArtworks();

  for (const artwork of artworks) {
    const image = LOCAL_IMAGE_BY_ARTWORK_ID[artwork.id] || artwork.image;
    if (!image) {
      skipped += 1;
      continue;
    }

    try {
      const vector = await embedImage(image);
      await prisma.$executeRawUnsafe(
        `
          INSERT INTO "ArtworkImageEmbedding"
            ("id", "artworkId", "image", "model", "dimensions", "embedding", "embeddingVector", "createdAt", "updatedAt")
          VALUES
            ($1, $2, $3, $4, $5, $6::jsonb, $7::vector, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT ("artworkId", "model") DO UPDATE SET
            "image" = EXCLUDED."image",
            "dimensions" = EXCLUDED."dimensions",
            "embedding" = EXCLUDED."embedding",
            "embeddingVector" = EXCLUDED."embeddingVector",
            "updatedAt" = CURRENT_TIMESTAMP
        `,
        randomUUID(),
        artwork.id,
        image,
        model,
        dimensions,
        JSON.stringify(vector),
        toPgVectorLiteral(vector),
      );
      indexed += 1;
      console.log(`indexed ${indexed}: ${artwork.id}`);
    } catch (error) {
      failed += 1;
      console.warn(`failed ${artwork.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await prisma.$disconnect();
}

console.log(JSON.stringify({ model, dimensions, indexed, skipped, failed }, null, 2));

async function loadArtworks() {
  const params = [];
  const removedFilter = REMOVED_ARTWORK_IDS.length
    ? `AND a."id" NOT IN (${REMOVED_ARTWORK_IDS.map((id) => {
        params.push(id);
        return `$${params.length}`;
      }).join(", ")})`
    : "";
  const forceFilter = force
    ? ""
    : `AND NOT EXISTS (
        SELECT 1
        FROM "ArtworkImageEmbedding" e
        WHERE e."artworkId" = a."id" AND e."model" = $${params.push(model)}
      )`;
  const limitClause = limit > 0 ? `LIMIT ${Math.max(1, Math.floor(limit))}` : "";

  return prisma.$queryRawUnsafe(
    `
      SELECT a."id", a."image"
      FROM "Artwork" a
      WHERE a."image" IS NOT NULL
        ${removedFilter}
        ${forceFilter}
      ORDER BY a."id" ASC
      ${limitClause}
    `,
    ...params,
  );
}

async function embedImage(image) {
  const rawImage = await rawImageFor(image);
  const output = await extractor(rawImage, { pooling: "mean", normalize: true });
  const vector = normalizeVector(tensorToVector(output));
  if (vector.length !== dimensions) throw new Error(`clip_embedding_dimensions_${vector.length}`);
  return vector;
}

async function rawImageFor(image) {
  if (image.startsWith("https://")) return rawImageFromRemoteUrl(image);
  if (!image.startsWith("/artworks/")) throw new Error("artwork_image_not_supported");

  const publicRoot = resolve(workspaceRoot, "frontend", "public");
  const resolvedPath = resolve(publicRoot, image.replace(/^\//, ""));
  if (!resolvedPath.startsWith(publicRoot)) throw new Error("artwork_image_not_supported");
  return rawImageFromLocalPath(resolvedPath);
}

async function rawImageFromLocalPath(path) {
  if (RawImage?.read) return RawImage.read(path);
  const bytes = await readFile(path);
  return rawImageFromBytes(bytes, mimeTypeFor(path));
}

async function rawImageFromRemoteUrl(url) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: new URL(url).origin,
      },
    },
    IMAGE_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) throw new Error(`artwork_image_download_failed_${response.status}`);

  const mimeType = imageMimeTypeFromContentType(response.headers.get("content-type"));
  if (!mimeType) throw new Error("artwork_image_invalid_type");

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > IMAGE_BYTES_MAX) throw new Error("artwork_image_too_large");
  return rawImageFromBytes(bytes, mimeType);
}

async function rawImageFromBytes(bytes, mimeType) {
  if (RawImage?.fromBlob) {
    return RawImage.fromBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }));
  }
  if (RawImage?.fromBuffer) {
    return RawImage.fromBuffer(new Uint8Array(bytes));
  }
  if (RawImage?.read) {
    return RawImage.read(`data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
  }
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function tensorToVector(output) {
  const candidate = Array.isArray(output) ? output[0] : output;
  const data = candidate?.data ?? candidate;
  const vector = Array.from(data ?? [], Number).filter((value) => Number.isFinite(value));
  if (!vector.length) throw new Error("clip_embedding_empty");
  return vector;
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) throw new Error("clip_embedding_empty");
  return vector.map((value) => value / magnitude);
}

function toPgVectorLiteral(vector) {
  return `[${vector.join(",")}]`;
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function imageMimeTypeFromContentType(contentType) {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase() || "";
  return ["image/jpeg", "image/png", "image/webp"].includes(normalized) ? normalized : "";
}

function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
