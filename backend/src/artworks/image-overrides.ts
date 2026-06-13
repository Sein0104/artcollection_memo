export const REMOVED_ARTWORK_IDS = [
  "plum-blossom",
  "shrimp",
  "aic-16568",
  "aic-89503",
  "reward-midnight",
  "reward-garden",
  "reward-gold-room",
];

const LOCAL_IMAGE_BY_ARTWORK_ID: Record<string, string> = {
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

export function withLocalArtworkImage<T extends { id: string; image: string | null }>(artwork: T) {
  if (!Object.prototype.hasOwnProperty.call(LOCAL_IMAGE_BY_ARTWORK_ID, artwork.id)) return artwork;
  return {
    ...artwork,
    image: LOCAL_IMAGE_BY_ARTWORK_ID[artwork.id],
  };
}
