// Person-name detection with CKIP's albert-tiny Chinese NER model (ONNX), run in the browser with onnxruntime-web.
// The tokenizer reproduces bert-base-chinese: BertNormalizer (clean text, space around CJK, no lowercase),
// BertPreTokenizer (split on whitespace and punctuation) and WordPiece ("##", max 100 chars per word).
(function (global) {
  'use strict';

  function isCJK(cp) {
    return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x20000 && cp <= 0x2A6DF) ||
      (cp >= 0x2A700 && cp <= 0x2B73F) || (cp >= 0x2B740 && cp <= 0x2B81F) || (cp >= 0x2B820 && cp <= 0x2CEAF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x2F800 && cp <= 0x2FA1F);
  }
  function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch);
  }
  function isControl(ch) {
    if (ch === '\t' || ch === '\n' || ch === '\r') return false;
    return /\p{Cc}|\p{Cf}/u.test(ch);
  }
  function isPunctuation(ch) {
    const cp = ch.codePointAt(0);
    if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
    return /\p{P}/u.test(ch);
  }

  // Returns [{text, start, end}] word pieces' source words with character offsets (UTF-16 indices).
  function preTokenize(text) {
    const words = [];
    let cur = null;
    const flush = () => { if (cur) { words.push(cur); cur = null; } };
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i), ch = String.fromCodePoint(cp), len = ch.length;
      if (cp === 0 || cp === 0xFFFD || isControl(ch)) { flush(); i += len; continue; }
      if (isWhitespace(ch)) { flush(); i += len; continue; }
      if (isCJK(cp) || isPunctuation(ch)) { flush(); words.push({ text: ch, start: i, end: i + len }); i += len; continue; }
      if (!cur) cur = { text: '', start: i, end: i };
      cur.text += ch; cur.end = i + len; i += len;
    }
    flush();
    return words;
  }

  function wordPiece(word, vocab) {
    const chars = Array.from(word.text);
    if (chars.length > 100) return [{ id: vocab.get('[UNK]'), start: word.start, end: word.end }];
    const pieces = [];
    let startChar = 0, offset = word.start;
    const charOffsets = [];
    for (const c of chars) { charOffsets.push(offset); offset += c.length; }
    charOffsets.push(offset);
    while (startChar < chars.length) {
      let endChar = chars.length, found = null;
      while (startChar < endChar) {
        let sub = chars.slice(startChar, endChar).join('');
        if (startChar > 0) sub = '##' + sub;
        if (vocab.has(sub)) { found = sub; break; }
        endChar--;
      }
      if (found === null) return [{ id: vocab.get('[UNK]'), start: word.start, end: word.end }];
      pieces.push({ id: vocab.get(found), start: charOffsets[startChar], end: charOffsets[endChar] });
      startChar = endChar;
    }
    return pieces;
  }

  function tokenize(text, vocab, maxLen) {
    const pieces = [];
    for (const w of preTokenize(text)) pieces.push(...wordPiece(w, vocab));
    const body = pieces.slice(0, maxLen - 2);
    return {
      ids: [vocab.get('[CLS]'), ...body.map(p => p.id), vocab.get('[SEP]')],
      offsets: [null, ...body.map(p => [p.start, p.end]), null],
    };
  }

  // BIES decoding over token offsets -> [{type, text, start, end}]
  function decode(text, offsets, labels) {
    const found = [];
    let cur = null;
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i];
      if (!off) continue;
      const tag = labels[i];
      if (tag === 'O') { cur = null; continue; }
      const dash = tag.indexOf('-'), pos = tag.slice(0, dash), type = tag.slice(dash + 1);
      if (pos === 'B' || pos === 'S' || !cur || cur.type !== type) { cur = { type, start: off[0], end: off[1] }; found.push(cur); }
      else cur.end = off[1];
      if (pos === 'E' || pos === 'S') cur = null;
    }
    return found.map(e => ({ type: e.type, text: text.slice(e.start, e.end), start: e.start, end: e.end }));
  }

  // The model sometimes swallows the last character of a job title ("師傅鄭文彥" -> "傅鄭文彥").
  // If that character and the text just before it spell a title, drop it from the name.
  const TITLES = ['師傅', '顧問', '經理', '主任', '店長', '組長', '會計', '專員', '助理', '老師', '主管', '課長', '處長', '老闆',
    '設計師', '工程師', '律師', '會計師', '護理師'];
  function trimTitle(line, e) {
    if (e.text.length < 3) return e.text;
    for (const t of TITLES) {
      const head = t.slice(0, -1);
      if (t.endsWith(e.text[0]) && line.slice(e.start - head.length, e.start) === head) return e.text.slice(1);
    }
    return e.text;
  }

  const NER = {
    session: null, vocab: null, id2label: null, ort: null,
    async load(base, ort) {
      const [vocabText, id2label] = await Promise.all([
        fetch(base + 'vocab.txt').then(r => r.text()),
        fetch(base + 'id2label.json').then(r => r.json()),
      ]);
      this.vocab = new Map(vocabText.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).map((t, i) => [t, i]));
      this.id2label = id2label;
      this.ort = ort;
      this.session = await ort.InferenceSession.create(base + 'ner.onnx', { executionProviders: ['wasm'] });
      return this;
    },
    tokenize(text) { return tokenize(text, this.vocab, 512); },
    async entities(line) {
      if (!line.trim()) return [];
      const { ids, offsets } = this.tokenize(line);
      const n = ids.length, T = this.ort.Tensor;
      const big = arr => BigInt64Array.from(arr, v => BigInt(v));
      const out = await this.session.run({
        input_ids: new T('int64', big(ids), [1, n]),
        attention_mask: new T('int64', big(new Array(n).fill(1)), [1, n]),
        token_type_ids: new T('int64', big(new Array(n).fill(0)), [1, n]),
      });
      const logits = out.logits.data, k = logits.length / n, labels = [];
      for (let i = 0; i < n; i++) {
        let best = 0;
        for (let j = 1; j < k; j++) if (logits[i * k + j] > logits[i * k + best]) best = j;
        labels.push(this.id2label[best]);
      }
      return decode(line, offsets, labels);
    },
    // Person names worth suggesting: 2-4 CJK characters, or capitalised Latin words.
    async personNames(text) {
      const names = [];
      for (const line of text.split('\n')) {
        for (const e of await this.entities(line)) {
          if (e.type !== 'PERSON') continue;
          const name = trimTitle(line, e);
          const ok = /^[一-鿿]{2,4}$/.test(name) || (/^[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*$/.test(name) && name.length >= 3);
          if (ok && !names.includes(name)) names.push(name);
        }
      }
      return names;
    },
  };
  NER._internal = { tokenize, preTokenize, decode };
  global.PiiNer = NER;
})(typeof window !== 'undefined' ? window : globalThis);
