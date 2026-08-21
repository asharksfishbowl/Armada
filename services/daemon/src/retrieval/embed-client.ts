/**
 * Forge-backed query embedding — the `embed` dependency PgVectorRetrievalProvider takes.
 *
 * The daemon has no embedding model. Forge does (bge-small, baked into its image per
 * roadmap F7), and platform boundary 1 assigns embeddings to forge. This client is the
 * whole of the daemon's side of that contract.
 *
 * IT ASSERTS COMPATIBILITY RATHER THAN TRUSTING IT. Forge returns `model` and `dim`
 * alongside the vectors, and this client checks the dimension against what the schema
 * stores. A forge on a different model would return vectors that are the wrong shape, or —
 * worse — the right shape from a different model, which would make query vectors and
 * indexed vectors incomparable and produce retrieval that is subtly wrong rather than
 * broken. The assert converts a silent failure into a loud one.
 */

/** Matches `chunks.embedding vector(384)` in migration 002. */
export const EMBEDDING_DIM = 384;

interface EmbedResponse {
  embeddings: number[][];
  model: string;
  dim: number;
}

export interface EmbedClientOptions {
  forgeUrl: string;
  timeoutMs?: number;
}

export class EmbedError extends Error {}

/**
 * Build the `(text) => Promise<number[]>` the retrieval provider expects.
 *
 * Returns a closure rather than a class because that is the entire surface the provider
 * needs — and keeping it to one function is what let P6 test the provider against a stub
 * with no network at all.
 */
export function createEmbedClient(options: EmbedClientOptions): (text: string) => Promise<number[]> {
  const { forgeUrl, timeoutMs = 10_000 } = options;

  return async (text: string): Promise<number[]> => {
    let response: Response;
    try {
      response = await fetch(`${forgeUrl}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Batch-capable endpoint, one text here. A caller with many texts should batch
        // rather than loop this.
        body: JSON.stringify({ texts: [text] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Edge 10 handles this upstream: the Step appends an `error` Event, injects NO
      // block, and the Run PROCEEDS. It deliberately does not fall back to the full-text
      // channel — R41 defines retrieval as hybrid RRF, so full-text alone is a different
      // algorithm rather than a degraded form of the same one, and R42's Event would
      // mislabel unfused scores as fused. An absent block is honest; a quietly-halved one
      // is not.
      throw new EmbedError(
        `armada-forge unreachable for query embedding: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new EmbedError(`armada-forge /embed returned ${response.status}`);
    }

    const body = (await response.json()) as EmbedResponse;
    const vector = body.embeddings?.[0];

    if (!Array.isArray(vector)) {
      throw new EmbedError('armada-forge /embed returned no embedding');
    }
    if (body.dim !== EMBEDDING_DIM || vector.length !== EMBEDDING_DIM) {
      throw new EmbedError(
        `embedding dimension mismatch: forge reported dim ${body.dim} ` +
          `(vector length ${vector.length}) from model ${body.model}, ` +
          `but chunks.embedding is vector(${EMBEDDING_DIM}). ` +
          'Query vectors and indexed vectors would not be comparable.',
      );
    }

    return vector;
  };
}
