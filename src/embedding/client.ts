import { loadConfig } from "../config.js";
import { withRetry } from "./retry.js";

export type EmbeddingResponse = {
  vectors: Float32Array[];
  error?: string;
};

type LiteLlmEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

const toFloat32Array = (values: number[]): Float32Array => {
  return Float32Array.from(values);
};

export const embedTexts = async (
  inputs: string[],
): Promise<EmbeddingResponse> => {
  if (inputs.length === 0) {
    return { vectors: [] };
  }

  const config = loadConfig();

  try {
    const response = await withRetry(async () => {
      const result = await fetch(`${config.litellm.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.litellm.apiKey}`,
        },
        body: JSON.stringify({
          model: config.litellm.embeddingModel,
          input: inputs,
          dimensions: 512,
        }),
      });

      if (!result.ok) {
        const text = await result.text();
        throw new Error(`LiteLLM error (${result.status}): ${text}`);
      }

      return (await result.json()) as LiteLlmEmbeddingResponse;
    });

    const vectors = response.data.map((item) => toFloat32Array(item.embedding));

    return { vectors };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Embedding request failed";
    return { vectors: [], error: message };
  }
};
