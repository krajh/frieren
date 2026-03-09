import { pipeline } from "@xenova/transformers";

export type EmbeddingResponse = {
  vectors: Float32Array[];
  error?: string;
};

const MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

type LocalPipeline = (
  inputs: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

let _extractor: LocalPipeline | null = null;

const getExtractor = async (): Promise<LocalPipeline> => {
  if (!_extractor) {
    _extractor = (await pipeline("feature-extraction", MODEL, {
      quantized: true,
    })) as unknown as LocalPipeline;
  }
  return _extractor;
};

export const embedTexts = async (
  inputs: string[],
): Promise<EmbeddingResponse> => {
  if (inputs.length === 0) return { vectors: [] };

  try {
    const extractor = await getExtractor();
    const output = await extractor(inputs, { pooling: "mean", normalize: true });
    const vectors: Float32Array[] = inputs.map((_, i) =>
      output.data.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
    );
    return { vectors };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Embedding failed";
    return { vectors: [], error: message };
  }
};
