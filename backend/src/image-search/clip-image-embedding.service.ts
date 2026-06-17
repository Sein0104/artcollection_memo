import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const DEFAULT_CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const DEFAULT_CLIP_DIMENSIONS = 512;
const IMAGE_DATA_URL_MAX_LENGTH = 4 * 1024 * 1024;
const IMAGE_BYTES_MAX = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=]+)$/i;

type TensorLike = {
  data?: ArrayLike<number>;
  dims?: number[];
};

type RawImageCtor = {
  read?: (input: string) => Promise<unknown>;
  fromBlob?: (input: Blob) => Promise<unknown>;
  fromBuffer?: (input: Uint8Array) => Promise<unknown>;
};

type TransformersModule = {
  env?: {
    cacheDir?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
  pipeline: (task: string, model: string) => Promise<(input: unknown, options?: Record<string, unknown>) => Promise<unknown>>;
  RawImage?: RawImageCtor;
};

@Injectable()
export class ClipImageEmbeddingService {
  private transformersModule?: Promise<TransformersModule>;
  private extractor?: Promise<(input: unknown, options?: Record<string, unknown>) => Promise<unknown>>;

  constructor(private readonly config: ConfigService) {}

  modelName() {
    return this.config.get<string>("CLIP_IMAGE_MODEL")?.trim() || DEFAULT_CLIP_MODEL;
  }

  dimensions() {
    return Number(this.config.get<string>("CLIP_IMAGE_DIMENSIONS") || DEFAULT_CLIP_DIMENSIONS);
  }

  async embedDataUrl(imageDataUrl: string) {
    const rawImage = await this.rawImageFromDataUrl(imageDataUrl);
    return this.embedRawImage(rawImage);
  }

  async embedArtworkImage(image: string) {
    if (image.startsWith("https://")) {
      const rawImage = await this.rawImageFromRemoteUrl(image);
      return this.embedRawImage(rawImage);
    }

    if (!image.startsWith("/artworks/")) {
      throw new BadRequestException("artwork_image_not_supported");
    }

    const workspaceRoot = process.cwd().endsWith("backend") ? resolve(process.cwd(), "..") : process.cwd();
    const publicRoot = resolve(workspaceRoot, "frontend", "public");
    const resolvedPath = resolve(publicRoot, image.replace(/^\//, ""));
    if (!resolvedPath.startsWith(publicRoot)) throw new BadRequestException("artwork_image_not_supported");

    const rawImage = await this.rawImageFromLocalPath(resolvedPath);
    return this.embedRawImage(rawImage);
  }

  async artworkImageToDataUrl(image: string) {
    if (image.startsWith("https://")) {
      const response = await this.fetchWithTimeout(
        image,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
            Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            Referer: new URL(image).origin,
          },
        },
        IMAGE_FETCH_TIMEOUT_MS,
      );
      if (!response.ok) throw new ServiceUnavailableException(`artwork_image_download_failed_${response.status}`);

      const mimeType = this.imageMimeTypeFromContentType(response.headers.get("content-type"));
      if (!mimeType) throw new ServiceUnavailableException("artwork_image_invalid_type");

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > IMAGE_BYTES_MAX) throw new BadRequestException("artwork_image_too_large");
      return `data:${mimeType};base64,${bytes.toString("base64")}`;
    }

    if (!image.startsWith("/artworks/")) {
      throw new BadRequestException("artwork_image_not_supported");
    }

    const workspaceRoot = this.workspaceRoot();
    const publicRoot = resolve(workspaceRoot, "frontend", "public");
    const resolvedPath = resolve(publicRoot, image.replace(/^\//, ""));
    if (!resolvedPath.startsWith(publicRoot)) throw new BadRequestException("artwork_image_not_supported");

    const bytes = await readFile(resolvedPath);
    if (bytes.byteLength > IMAGE_BYTES_MAX) throw new BadRequestException("artwork_image_too_large");
    return `data:${this.mimeTypeFor(resolvedPath)};base64,${bytes.toString("base64")}`;
  }

  private async embedRawImage(rawImage: unknown) {
    const extractor = await this.getExtractor();
    const output = await extractor(rawImage, { pooling: "mean", normalize: true });
    const vector = this.normalizeVector(this.tensorToVector(output));

    if (vector.length !== this.dimensions()) {
      throw new ServiceUnavailableException(`clip_embedding_dimensions_${vector.length}`);
    }

    return vector;
  }

  private async getExtractor() {
    if (!this.extractor) {
      this.extractor = this.getTransformers().then((module) => module.pipeline("image-feature-extraction", this.modelName()));
    }
    return this.extractor;
  }

  private async getTransformers() {
    if (!this.transformersModule) {
      this.transformersModule = this.importTransformers().then((module) => {
        if (module.env) {
          const cacheDir = this.config.get<string>("CLIP_CACHE_DIR")?.trim();
          module.env.cacheDir = cacheDir || resolve(this.workspaceRoot(), "backend", ".cache", "transformers");
          module.env.allowLocalModels = true;
          module.env.allowRemoteModels = true;
        }
        return module;
      });
    }
    return this.transformersModule;
  }

  private async importTransformers() {
    try {
      const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<TransformersModule>;
      return await load("@xenova/transformers");
    } catch (error) {
      throw new ServiceUnavailableException(error instanceof Error ? `clip_transformers_unavailable: ${error.message}` : "clip_transformers_unavailable");
    }
  }

  private workspaceRoot() {
    return process.cwd().endsWith("backend") ? resolve(process.cwd(), "..") : process.cwd();
  }

  private async rawImageFromLocalPath(path: string) {
    const module = await this.getTransformers();
    if (module.RawImage?.read) return module.RawImage.read(path);

    const bytes = await readFile(path);
    return this.rawImageFromBytes(bytes, this.mimeTypeFor(path));
  }

  private async rawImageFromRemoteUrl(url: string) {
    const response = await this.fetchWithTimeout(
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
    if (!response.ok) throw new ServiceUnavailableException(`artwork_image_download_failed_${response.status}`);

    const mimeType = this.imageMimeTypeFromContentType(response.headers.get("content-type"));
    if (!mimeType) throw new ServiceUnavailableException("artwork_image_invalid_type");

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > IMAGE_BYTES_MAX) throw new BadRequestException("artwork_image_too_large");
    return this.rawImageFromBytes(bytes, mimeType);
  }

  private async rawImageFromDataUrl(dataUrl: string) {
    if (dataUrl.length > IMAGE_DATA_URL_MAX_LENGTH) throw new BadRequestException("image_too_large");

    const match = dataUrl.match(IMAGE_DATA_URL_PATTERN);
    if (!match) throw new BadRequestException("image_invalid_type");

    const bytes = Buffer.from(match[2], "base64");
    if (bytes.byteLength > IMAGE_BYTES_MAX) throw new BadRequestException("image_too_large");
    return this.rawImageFromBytes(bytes, match[1]);
  }

  private async rawImageFromBytes(bytes: Uint8Array, mimeType: string) {
    const module = await this.getTransformers();
    if (module.RawImage?.fromBlob) {
      return module.RawImage.fromBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }));
    }
    if (module.RawImage?.fromBuffer) {
      return module.RawImage.fromBuffer(new Uint8Array(bytes));
    }
    if (module.RawImage?.read) {
      const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      return module.RawImage.read(dataUrl);
    }
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  }

  private tensorToVector(output: unknown): number[] {
    const candidate = Array.isArray(output) ? output[0] : output;
    const data = this.outputData(candidate);
    const vector = Array.from(data, Number).filter((value) => Number.isFinite(value));
    if (!vector.length) throw new ServiceUnavailableException("clip_embedding_empty");
    return vector;
  }

  private outputData(output: unknown): ArrayLike<number> {
    if (output && typeof output === "object" && "data" in output) {
      const tensor = output as TensorLike;
      if (tensor.data?.length) return tensor.data;
    }
    if (ArrayBuffer.isView(output)) return Array.from(output as unknown as ArrayLike<number>);
    if (Array.isArray(output)) return output as ArrayLike<number>;
    throw new ServiceUnavailableException("clip_embedding_invalid");
  }

  private normalizeVector(vector: number[]) {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!magnitude) throw new ServiceUnavailableException("clip_embedding_empty");
    return vector.map((value) => value / magnitude);
  }

  private fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
  }

  private imageMimeTypeFromContentType(contentType: string | null) {
    const normalized = contentType?.split(";")[0]?.trim().toLowerCase() || "";
    return ["image/jpeg", "image/png", "image/webp"].includes(normalized) ? normalized : "";
  }

  private mimeTypeFor(path: string) {
    const extension = extname(path).toLowerCase();
    if (extension === ".png") return "image/png";
    if (extension === ".webp") return "image/webp";
    return "image/jpeg";
  }
}
