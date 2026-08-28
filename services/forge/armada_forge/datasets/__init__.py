"""Dataset construction — Training R15-R20, R33.

Three sample sources, exactly one of which can cost money:

  supplied      operator JSONL under /data/supplied/. Free. R15a.
  trajectory    successful Runs read from `events`. Free. R17.
  distilled     teacher-generated from Corpus chunks. Requires config/teacher.yaml
                `enabled: true`, and with `provider: remote` is the ONLY thing in the
                platform that can incur spend. R16, R16b.

A default installation has the teacher disabled, so the buildable sources are the two free
ones. That is invariant 7 expressed as a code path rather than as a promise.
"""
