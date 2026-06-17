import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const dataDir = resolve(process.cwd(), "..", "data");
const seedPath = resolve(dataDir, "seed-data.json");
const importedPath = resolve(dataDir, "imported-artworks.json");
const targetCount = Number(process.env.ARTCATCH_IMPORT_LIMIT || 80);
const sourceLimit = Math.max(80, targetCount);

const seed = JSON.parse(await readFile(seedPath, "utf8"));
const imported = await readOptionalJson(importedPath, { artworks: [] });
const existingIds = new Set([...(seed.artworks ?? []), ...(imported.artworks ?? [])].map((art) => art.id));
const existingTitles = new Set([...(seed.artworks ?? []), ...(imported.artworks ?? [])].map((art) => normalize(art.title)));

const candidates = [
  ...(await safeSource("Art Institute of Chicago", () => fetchArtInstituteCandidates(sourceLimit))),
  ...(await safeSource("Cleveland Museum of Art", () => fetchClevelandCandidates(sourceLimit))),
];

const nextImported = uniqueById([
  ...(imported.artworks ?? []),
  ...candidates.filter((art) => art.image && !existingIds.has(art.id) && !existingTitles.has(normalize(art.title))),
]).slice(0, Math.max(targetCount, imported.artworks?.length ?? 0));

await writeFile(importedPath, `${JSON.stringify({ artworks: nextImported }, null, 2)}\n`, "utf8");

for (const art of nextImported) {
  await prisma.artwork.upsert({
    where: { id: art.id },
    update: toArtworkData(art),
    create: { id: art.id, ...toArtworkData(art) },
  });
}

await prisma.$disconnect();

console.log(`Imported ${nextImported.length} open-access artworks into ${importedPath}`);

async function readOptionalJson(path, fallback) {
  return readFile(path, "utf8")
    .then((content) => JSON.parse(content))
    .catch((error) => {
      if (error.code === "ENOENT") return fallback;
      throw error;
    });
}

async function fetchArtInstituteCandidates(limit) {
  const params = new URLSearchParams({
    params: JSON.stringify({
      limit,
      query: {
        bool: {
          must: [{ term: { is_public_domain: true } }, { exists: { field: "image_id" } }],
        },
      },
    }),
    fields: [
      "id",
      "title",
      "artist_title",
      "artist_display",
      "date_display",
      "date_start",
      "place_of_origin",
      "style_title",
      "classification_title",
      "department_title",
      "medium_display",
      "image_id",
    ].join(","),
  });

  const payload = await fetchJson(`https://api.artic.edu/api/v1/artworks/search?${params}`, {
    "AIC-User-Agent": "ArtCatch local import",
  });
  const iiifBase = payload?.config?.iiif_url || "https://www.artic.edu/iiif/2";
  return (payload?.data ?? []).map((item) => {
    const text = [
      item.place_of_origin,
      item.style_title,
      item.classification_title,
      item.department_title,
      item.medium_display,
    ].filter(Boolean);
    const origin = inferOrigin(text);
    const category = inferCategory(text, origin);
    return {
      id: `aic-${item.id}`,
      title: item.title || `Art Institute work ${item.id}`,
      artist: item.artist_title || firstLine(item.artist_display) || "Unknown artist",
      year: item.date_display || String(item.date_start || "연도 미상"),
      origin,
      period: item.style_title || item.department_title || "Open Access",
      region: item.place_of_origin || "지역 미상",
      category,
      tags: unique([item.classification_title, item.department_title, item.medium_display, ...category].filter(Boolean)).slice(0, 5),
      palette: paletteFromText(`${item.title} ${item.artist_title} ${item.image_id}`),
      image: `${iiifBase}/${item.image_id}/full/843,/0/default.jpg`,
      premium: false,
      cost: 0,
    };
  });
}

async function fetchClevelandCandidates(limit) {
  const queries = ["painting", "sculpture", "ceramic", "installation", "textile", "photograph", "print", "vessel"];
  const perQuery = Math.max(8, Math.ceil(limit / queries.length));
  const responses = await Promise.all(
    queries.map((query, index) =>
      fetchJson(
        `https://openaccess-api.clevelandart.org/api/artworks?${new URLSearchParams({
          q: query,
          skip: String(index * perQuery),
          limit: String(perQuery),
          has_image: "1",
        })}`,
      ).catch((error) => {
        console.warn(`Skipped Cleveland query "${query}": ${error.message}`);
        return { data: [] };
      }),
    ),
  );

  return responses.flatMap((payload) =>
    (payload?.data ?? []).map((item) => {
      const creator = Array.isArray(item.creators) && item.creators.length ? item.creators.map((artist) => artist.description || artist.name).filter(Boolean).join(", ") : "";
      const culture = Array.isArray(item.culture) ? item.culture[0] : item.culture;
      const text = [
        culture,
        item.creation_location,
        item.department,
        item.type,
        item.technique,
        item.date_text,
      ].filter(Boolean);
      const origin = inferOrigin(text);
      const category = inferCategory(text, origin);
      return {
        id: `cma-${slug(item.accession_number || item.id || item.title)}`,
        title: item.title || "Cleveland artwork",
        artist: creator || "Unknown artist",
        year: item.date_text || String(item.sortable_date || "연도 미상"),
        origin,
        period: item.department || item.type || "Open Access",
        region: item.creation_location || culture || "지역 미상",
        category,
        tags: unique([item.type, item.department, item.technique, ...category].filter(Boolean)).slice(0, 5),
        palette: paletteFromText(`${item.title} ${creator} ${item.accession_number}`),
        image: item.images?.web?.url,
        premium: false,
        cost: 0,
      };
    }),
  );
}

async function safeSource(name, loader) {
  try {
    return await loader();
  } catch (error) {
    console.warn(`Skipped ${name}: ${error.message}`);
    return [];
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json();
}

function toArtworkData(art) {
  return {
    title: art.title,
    artist: art.artist,
    year: art.year,
    origin: art.origin,
    period: art.period,
    region: art.region,
    category: art.category ?? [],
    tags: art.tags ?? [],
    palette: art.palette ?? [120, 120, 120],
    image: art.image ?? null,
    premium: Boolean(art.premium),
    cost: art.cost ?? 0,
    featureVector: featureVector(art),
  };
}

function featureVector(art) {
  const text = [...(art.tags ?? []), ...(art.category ?? []), art.period, art.origin].join(" ").toLowerCase();
  const hasAny = (words) => words.some((word) => text.includes(word.toLowerCase()));
  return {
    portrait: hasAny(["portrait", "인물", "초상"]) ? 0.9 : 0.12,
    landscape: hasAny(["landscape", "풍경", "자연", "바다", "산"]) ? 0.92 : 0.16,
    ink: hasAny(["ink", "수묵", "calligraphy"]) ? 0.86 : 0.18,
    detail: hasAny(["abstract", "pattern", "decorative", "추상", "패턴", "장식"]) ? 0.82 : 0.42,
    colorHash: createHash("sha1").update(JSON.stringify(art.palette ?? [])).digest("hex"),
  };
}

function inferOrigin(parts) {
  const text = parts.join(" ").toLowerCase();
  if (/(korea|japan|china|india|asian|islamic|egyptian|near eastern|동양|한국|일본|중국)/.test(text)) return "동양";
  return "서양";
}

function inferCategory(parts, origin) {
  const text = parts.join(" ").toLowerCase();
  const categories = [origin];
  if (/(sculpture|statue|bronze|stone|조각)/.test(text)) categories.push("조각");
  if (/(ceramic|porcelain|vessel|textile|furniture|decorative|craft|공예)/.test(text)) categories.push("공예");
  if (/(photograph|film|video|media|미디어)/.test(text)) categories.push("미디어아트");
  if (/(modern|contemporary|20th|현대)/.test(text)) categories.push("현대");
  if (/(print|woodblock|engraving|etching)/.test(text)) categories.push("판화");
  if (/(portrait|인물|초상)/.test(text)) categories.push("초상");
  if (/(landscape|풍경|nature)/.test(text)) categories.push("풍경");
  return unique(categories);
}

function paletteFromText(text) {
  const hash = createHash("sha1").update(text).digest();
  return [hash[0], hash[1], hash[2]].map((value) => Math.max(36, Math.min(220, value)));
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id) || !item.image?.startsWith("https://")) return false;
    seen.add(item.id);
    return true;
  });
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function firstLine(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}
