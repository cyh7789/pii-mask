"""Rebuild model/ from the original CKIP checkpoint.

    pip install torch transformers onnx
    python3 tools/export_model.py

Writes model/ner.onnx (same weights as ckiplab/albert-tiny-chinese-ner, ONNX opset 17),
model/id2label.json and model/vocab.txt (the bert-base-chinese vocabulary the CKIP models use).
"""
import json
import pathlib

import torch
from transformers import AutoModelForTokenClassification, BertTokenizerFast

OUT = pathlib.Path(__file__).resolve().parent.parent / "model"
OUT.mkdir(exist_ok=True)

tokenizer = BertTokenizerFast.from_pretrained("bert-base-chinese")
model = AutoModelForTokenClassification.from_pretrained("ckiplab/albert-tiny-chinese-ner").eval()
sample = tokenizer("申請人：王小明表示要請假", return_tensors="pt")
inputs = ["input_ids", "attention_mask", "token_type_ids"]
torch.onnx.export(
    model, tuple(sample[k] for k in inputs), OUT / "ner.onnx",
    input_names=inputs, output_names=["logits"],
    dynamic_axes={k: {0: "batch", 1: "seq"} for k in inputs + ["logits"]},
    opset_version=17, dynamo=False,
)
(OUT / "id2label.json").write_text(json.dumps({int(k): v for k, v in model.config.id2label.items()}, ensure_ascii=False), encoding="utf-8")
vocab = sorted(tokenizer.get_vocab().items(), key=lambda kv: kv[1])
(OUT / "vocab.txt").write_text("\n".join(token for token, _ in vocab) + "\n", encoding="utf-8")
print("written to", OUT)
