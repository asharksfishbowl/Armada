"""armada-forge — corpus ingestion, dataset construction, training, model registry.

Owns writing chunks and embeddings into armada-db; armada-daemon owns querying them at
agent time (platform boundary 1). The forge never serves a retrieval query to an agent.
"""

__version__ = "0.1.0"
