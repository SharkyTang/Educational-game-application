# Street-neighbour speech

The 41 WAV files under `street-neighbours/sam/` and
`street-neighbours/ellis/` are local **synthetic speech** generated on
2026-09-01. They are not human recordings, browser voices or calls to an online
speech service. Sam and Ellis use independent reviewed British-English speaker
models; neither voice is a pitch-shifted copy of the other.

- **Sam** uses the public-domain ManyVoice `Martin_Clifton` speaker 15.
- **Ellis** uses the public-domain Cori medium female model.
- Both models come from [Bryce Beattie's official Piper voice page](https://brycebeattie.com/files/tts/).
- Model weights, hashes, speaker IDs and synthesis settings are recorded in
  `street-neighbour-manifest.json`.

The same permissions and model provenance are described in detail in the
existing [customer voice source record](./customer-phrase-SOURCES.md). The
underlying LibriVox readers did not perform these fictional lines and do not
endorse the game, its characters or its portrayal of homelessness.

`src/sim3d/streetNeighbourCorpus.json` is the single editable bilingual source.
It contains consent-led greetings, ordinary weather and neighbourhood chat,
ask-first responses, Patch-specific boundaries, exact £1/£2 acknowledgements,
daily-cap responses, no-pressure endings and fictional local-outreach wording.
Sam alone has dog dialogue. There is deliberately no pleading, moral score,
gratitude escalation, bark or growl recording.

Reproduce the complete dedicated set without changing existing customer audio:

```sh
tmp/piper-env/bin/python scripts/generate-street-neighbour-speech.py
npm test -- tests/unit/sim3d-street-neighbour-assets.test.ts
```

Authoring uses Piper 1.7.0, ONNX Runtime 1.19.2 and NumPy 2.0.2 in the ignored
isolated environment. The browser ships only the generated PCM WAV files. The
script verifies the pinned input hashes, captions, format, duration, loudness
and an 8 MB batch budget before writing. The manifest records the resulting
file sizes, durations, levels and SHA-256 hashes. Automated checks cannot judge
pronunciation, warmth or whether lived-experience reviewers find a line
appropriate; those remain human review tasks.
