class WhisperAudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferSize = 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.bytesWritten = 0;
        this.rawSquares = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input && input.length > 0) {
            const channelData = input[0];
            // Second input carries the unprocessed signal for silence detection
            const rawData = inputs[1] && inputs[1].length > 0 ? inputs[1][0] : channelData;

            // Accumulate samples into 4096-sample chunks
            for (let i = 0; i < channelData.length; i++) {
                this.buffer[this.bytesWritten++] = channelData[i];
                this.rawSquares += rawData[i] * rawData[i];

                if (this.bytesWritten >= this.bufferSize) {
                    const rms = Math.sqrt(this.rawSquares / this.bufferSize);
                    this.port.postMessage({ audio: this.buffer, rms }, [this.buffer.buffer]);
                    this.buffer = new Float32Array(this.bufferSize);
                    this.bytesWritten = 0;
                    this.rawSquares = 0;
                }
            }
        }
        return true;
    }
}

registerProcessor('whisper-audio-processor', WhisperAudioProcessor);
