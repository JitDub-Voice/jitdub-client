// AudioWorklet записи: копит входной сигнал блоками и отдаёт их в основной поток вместе с номером кадра
// контекста (currentFrame) — по нему запись точно привязывается к таймлайну. Заодно считает пик для индикатора.
class JitDubRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.start = 0;
    this.peak = 0;
    this.meterAt = 0;
    this.port.onmessage = e => {
      if (e.data.rec === true) { this.rec = true; this.n = 0; }
      if (e.data.rec === false) { this.flush(); this.rec = false; this.port.postMessage({ done: true }); }
    };
  }

  flush() {
    if (!this.n) return;
    this.port.postMessage({ frame: this.start, data: this.buf.slice(0, this.n) });
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > this.peak) this.peak = a; }
    if (currentFrame - this.meterAt > sampleRate / 30) {
      this.port.postMessage({ peak: this.peak });
      this.peak = 0;
      this.meterAt = currentFrame;
    }
    if (this.rec) {
      if (this.n === 0) this.start = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n + ch.length > this.buf.length) this.flush();
    }
    return true;
  }
}

registerProcessor('jitdub-recorder', JitDubRecorder);
