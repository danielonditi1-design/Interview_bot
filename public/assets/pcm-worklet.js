// AudioWorklet that forwards raw mono PCM (Float32) to the main thread in ~2048-sample blocks.
class PCMCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(2048);
        this.filled = 0;
    }
    process(inputs) {
        const input = inputs[0];
        if (input && input[0]) {
            const left = input[0];
            const right = input[1];
            for (let i = 0; i < left.length; i++) {
                this.buffer[this.filled++] = right ? (left[i] + right[i]) * 0.5 : left[i];
                if (this.filled === this.buffer.length) {
                    this.port.postMessage(this.buffer.slice(0));
                    this.filled = 0;
                }
            }
        }
        return true;
    }
}
registerProcessor('pcm-capture', PCMCapture);
