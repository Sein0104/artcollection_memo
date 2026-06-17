import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const seedPath = resolve(process.cwd(), "..", "data", "seed-data.json");
const importedPath = resolve(process.cwd(), "..", "data", "imported-artworks.json");
const seed = JSON.parse(await readFile(seedPath, "utf8"));
const imported = await readOptionalJson(importedPath, { artworks: [] });

function readOptionalJson(path, fallback) {
  return readFile(path, "utf8")
    .then((content) => JSON.parse(content))
    .catch((error) => {
      if (error.code === "ENOENT") return fallback;
      throw error;
    });
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function featureVector(art) {
  const text = [...(art.tags ?? []), ...(art.category ?? []), art.period, art.origin].join(" ");
  const hasAny = (words) => words.some((word) => text.includes(word));
  return {
    portrait: hasAny(["초상", "인물", "사람"]) ? 0.9 : 0.12,
    landscape: hasAny(["풍경", "산", "바다", "파도", "자연", "연못"]) ? 0.92 : 0.16,
    ink: hasAny(["수묵", "먹", "여백", "한국화", "산수"]) ? 0.86 : 0.18,
    detail: hasAny(["추상", "패턴", "장식", "소용돌이"]) ? 0.82 : 0.42,
    colorHash: createHash("sha1").update(JSON.stringify(art.palette ?? [])).digest("hex"),
  };
}

const artworks = uniqueById([...(seed.artworks ?? []), ...(imported.artworks ?? [])]);
const activeArtworkIds = artworks.map((art) => art.id);

await prisma.user.updateMany({
  where: { installedRewardId: { notIn: activeArtworkIds } },
  data: { installedRewardId: null },
});
await prisma.collectionEntry.deleteMany({ where: { artworkId: { notIn: activeArtworkIds } } });
await prisma.missionCompletion.deleteMany({ where: { artworkId: { notIn: activeArtworkIds } } });
await prisma.purchase.deleteMany({ where: { artworkId: { notIn: activeArtworkIds } } });
await prisma.artwork.deleteMany({ where: { id: { notIn: activeArtworkIds } } });

for (const art of artworks) {
  await prisma.artwork.upsert({
    where: { id: art.id },
    update: {
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
    },
    create: {
      id: art.id,
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
    },
  });
}

for (const museum of seed.museums) {
  await prisma.museum.upsert({
    where: { id: museum.id },
    update: {
      name: museum.name,
      scope: museum.scope,
      country: museum.country,
      area: museum.area,
      city: museum.city,
      tags: museum.tags ?? [],
    },
    create: {
      id: museum.id,
      name: museum.name,
      scope: museum.scope,
      country: museum.country,
      area: museum.area,
      city: museum.city,
      tags: museum.tags ?? [],
    },
  });
}

for (const post of seed.posts) {
  const author = await prisma.user.upsert({
    where: { nickname: post.author },
    update: {},
    create: {
      nickname: post.author,
      passwordHash: "seed",
      passwordSalt: "seed",
      points: 40,
    },
  });

  await prisma.post.upsert({
    where: { id: post.id },
    update: {
      title: post.title,
      body: post.body,
      museumId: post.museumId,
      boardType: post.boardType ?? "free",
      upVotes: post.upVotes ?? 0,
      downVotes: post.downVotes ?? 0,
    },
    create: {
      id: post.id,
      authorId: author.id,
      title: post.title,
      body: post.body,
      museumId: post.museumId,
      boardType: post.boardType ?? "free",
      upVotes: post.upVotes ?? 0,
      downVotes: post.downVotes ?? 0,
      createdAt: new Date(post.createdAt),
    },
  });
}

await prisma.$disconnect();
