"""Transcribe an audio file using faster-whisper. Prints text to stdout."""
import sys
from faster_whisper import WhisperModel

if len(sys.argv) < 3:
    print("Usage: transcribe.py <model> <audio_file>", file=sys.stderr)
    sys.exit(1)

model_name = sys.argv[1]
audio_file = sys.argv[2]

model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio_file, beam_size=5)
print(" ".join(seg.text.strip() for seg in segments))
