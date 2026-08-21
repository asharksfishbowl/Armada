/**
 * PgVectorRetrievalProvider — Agent Runtime R41.
 *
 * Hybrid retrieval: a cosine-distance vector search AND a tsvector full-text search, each
 * returning k*3 candidates, fused with Reciprocal Rank Fusion at `rrf_k`, returning top k.
 *
 * WHY BOTH CHANNELS. Vector search finds semantic neighbours and misses exact tokens — an
 * error code, a flag name, an identifier — because an embedding of `--no-verify` is not
 * meaningfully near a question about it. Full-text finds those exactly and misses
 * paraphrase. Fusing them is what makes retrieval work for a corpus that is half prose and
 * half code, which is exactly the corpus Armada ingests.
 *
 * WHY RRF RATHER THAN SCORE BLENDING. The two channels produce incomparable numbers:
 * cosine distance is bounded and metric, ts_rank is unbounded and corpus-dependent.
 * Normalising them against each other requires a weighting nobody can justify from first
 * principles and that drifts as a corpus grows. RRF discards magnitudes and fuses RANKS —
 * 1/(rrf_k + rank) per channel, summed — so it needs no tuning and cannot be skewed by one
 * channel's scale.
 *
 * READ-ONLY BY CONTRACT. Platform boundary 1: armada-forge writes the vector index, the
 * daemon only queries it. The RetrievalProvider interface has no write method, and this
 * class issues no statement other than SELECT.
 */

import type { Pool } from 'pg';
import type { Chunk, RetrievalProvider } from '../kernel/types.js';

export interface RetrievalOptions {
  /** R41 — RRF constant. Larger values flatten the contribution of top ranks. */
  rrfK: number;
  /** Candidates fetched per channel, as a multiple of k (R41 says k*3). */
  candidateMultiplier: number;
}

export const DEFAULT_RETRIEVAL_OPTIONS: RetrievalOptions = {
  rrfK: 60,
  candidateMultiplier: 3,
};

interface CandidateRow {
  chunk_id: string;
  content: string;
  source_path: string;
  rank: string;
}

export class PgVectorRetrievalProvider implements RetrievalProvider {
  readonly name = 'PgVectorRetrievalProvider';

  constructor(
    private readonly pool: Pool,
    private readonly embed: (text: string) => Promise<number[]>,
    private readonly options: RetrievalOptions = DEFAULT_RETRIEVAL_OPTIONS,
  ) {}

  /**
   * Hybrid query against one Corpus.
   *
   * Edge 9 — a zero-chunk Corpus returns an empty list rather than throwing. Both shipped
   * example Agents hit that path on a fresh installation, so it is the common case at
   * first run, not an error.
   */
  async query(corpusId: string, text: string, k: number): Promise<Chunk[]> {
    if (k <= 0) return [];

    const candidates = k * this.options.candidateMultiplier;
    const embedding = await this.embed(text);

    // Both channels in ONE statement. Two round-trips would double the latency of every
    // Step's first retrieval for no benefit, and the fusion has to happen somewhere —
    // doing it in SQL keeps the candidate rows from crossing the wire twice.
    //
    // RRF: score = SUM over channels of 1 / (rrf_k + rank_in_that_channel). A chunk found
    // by only one channel still scores; a chunk found by both outranks it. `FULL OUTER
    // JOIN` is what admits the one-channel case rather than silently requiring both.
    const result = await this.pool.query<CandidateRow & { fused: string }>(
      `
      WITH vector_hits AS (
        SELECT chunk_id, content, source_path,
               ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
          FROM chunks
         WHERE corpus_id = $1::uuid
         ORDER BY embedding <=> $2::vector
         LIMIT $3
      ),
      text_hits AS (
        SELECT chunk_id, content, source_path,
               ROW_NUMBER() OVER (
                 ORDER BY ts_rank(to_tsvector('english', content),
                                  plainto_tsquery('english', $4)) DESC
               ) AS rank
          FROM chunks
         WHERE corpus_id = $1::uuid
           AND to_tsvector('english', content) @@ plainto_tsquery('english', $4)
         ORDER BY ts_rank(to_tsvector('english', content),
                          plainto_tsquery('english', $4)) DESC
         LIMIT $3
      )
      SELECT COALESCE(v.chunk_id, t.chunk_id)       AS chunk_id,
             COALESCE(v.content, t.content)         AS content,
             COALESCE(v.source_path, t.source_path) AS source_path,
             COALESCE(1.0 / ($5 + v.rank), 0.0)
           + COALESCE(1.0 / ($5 + t.rank), 0.0)     AS fused,
             COALESCE(v.rank, t.rank)               AS rank
        FROM vector_hits v
        FULL OUTER JOIN text_hits t ON v.chunk_id = t.chunk_id
       ORDER BY fused DESC
       LIMIT $6
      `,
      [
        corpusId,
        // pgvector accepts the bracketed array literal form.
        `[${embedding.join(',')}]`,
        candidates,
        text,
        this.options.rrfK,
        k,
      ],
    );

    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      content: row.content,
      sourcePath: row.source_path,
      score: Number(row.fused),
    }));
  }
}

/**
 * Build the system-role block injected on the first Step of a Turn — R39.
 *
 * Each chunk carries its `source_path` so a model can cite where a claim came from, and so
 * an operator reading the event stream can check it. A block of anonymous text would make
 * the retrieval unauditable.
 *
 * Edge 11 — when the block alone exceeds the context budget, chunks are dropped from
 * LOWEST fused score upward until it fits, and the count is reported so the `retrieval`
 * Event can record `chunks_dropped`. Dropping the worst matches is the only ordering that
 * preserves the point of ranking them.
 */
export function buildInjectionBlock(
  chunks: Chunk[],
  maxTokens: number,
  estimateTokens: (text: string) => number,
): { block: string | null; used: Chunk[]; chunksDropped: number } {
  // Edge 9 — a zero-chunk result injects NO block at all. An empty "here is what I found"
  // header is worse than silence: it spends context to tell the model nothing.
  if (chunks.length === 0) return { block: null, used: [], chunksDropped: 0 };

  const render = (list: Chunk[]): string =>
    ['Retrieved context:', ...list.map((c) => `--- ${c.sourcePath}\n${c.content}`)].join('\n\n');

  // Highest score first, so dropping from the tail drops the weakest matches.
  const ordered = [...chunks].sort((a, b) => b.score - a.score);
  let used = ordered;

  while (used.length > 0 && estimateTokens(render(used)) > maxTokens) {
    used = used.slice(0, -1);
  }

  if (used.length === 0) {
    // Even the single best chunk does not fit. Injecting a truncated fragment would give
    // the model a source_path pointing at content it cannot see.
    return { block: null, used: [], chunksDropped: chunks.length };
  }

  return { block: render(used), used, chunksDropped: chunks.length - used.length };
}
