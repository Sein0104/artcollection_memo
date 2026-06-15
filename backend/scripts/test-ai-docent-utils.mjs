import assert from "node:assert/strict";
import { AiDocentService } from "../dist/ai-docent/ai-docent.service.js";

const artworks = [
  {
    id: "starry-night",
    title: "별이 빛나는 밤",
    artist: "빈센트 반 고흐",
    year: "1889",
    origin: "서양",
    period: "후기인상주의",
    region: "프랑스",
    category: ["인상주의", "풍경"],
    tags: ["밤", "푸른빛"],
    palette: [30, 50, 120],
    image: "/artworks/starry-night.jpg",
    premium: false,
    cost: 0,
  },
  {
    id: "water-lilies",
    title: "수련",
    artist: "클로드 모네",
    year: "1916",
    origin: "서양",
    period: "인상주의",
    region: "프랑스",
    category: ["인상주의", "풍경"],
    tags: ["연못", "빛"],
    palette: [80, 130, 90],
    image: "/artworks/water-lilies.jpg",
    premium: false,
    cost: 0,
  },
  {
    id: "mona-lisa",
    title: "모나리자",
    artist: "레오나르도 다 빈치",
    year: "1503",
    origin: "서양",
    period: "르네상스",
    region: "이탈리아",
    category: ["초상", "르네상스"],
    tags: ["인물", "고전"],
    palette: [110, 80, 50],
    image: "/artworks/mona-lisa.jpg",
    premium: false,
    cost: 0,
  },
];

const service = new AiDocentService(
  {
    artwork: {
      findMany: async () => artworks,
    },
  },
  {},
  {},
  {},
);

const impressionist = await service.findAttributeMatchedArtworks("인상주의 작품에는 뭐가 있어?");
assert.deepEqual(
  impressionist.map((artwork) => artwork.id),
  ["starry-night", "water-lilies"],
);
console.log("PASS docent category matching uses artwork attributes");

const cleaned = service.cleanAnswer("추천 작품은 \u001bstarry-night\u001d, aic-28560 입니다.", ["starry-night"]);
assert.equal(cleaned.includes("starry-night"), false);
assert.equal(cleaned.includes("aic-28560"), false);
assert.equal(cleaned.includes("\u001b"), false);
assert.equal(cleaned.includes("\u001d"), false);
console.log("PASS docent answer cleanup removes internal ids");

const limitedPhrase = service.cleanAnswer("현재 ArtCatch 데이터가 부족합니다. 모나리자는 초상 작품입니다.", []);
assert.equal(limitedPhrase.includes("데이터가 부족"), false);
assert.equal(limitedPhrase.includes("모나리자는 초상 작품입니다."), true);
console.log("PASS docent answer cleanup removes data limitation wording");

assert.deepEqual(service.normalizeSuggestedArtworkIds(["mona-lisa", "starry-night"], ["mona-lisa", "starry-night"], 1), ["mona-lisa"]);
assert.deepEqual(service.normalizeSuggestedArtworkIds([], ["mona-lisa", "starry-night"], 1), ["mona-lisa"]);
console.log("PASS docent suggestion limit supports single-artwork answers");
