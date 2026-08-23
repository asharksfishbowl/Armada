"""BaseModel shortlist, ModelBinding records, and materialization.

Cross-service boundary 2: armada-forge registers ModelBindings with armada-models and the
daemon only ever consumes them by tag. Materialization lives here for the same reason.
"""
